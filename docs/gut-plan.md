# Gut the UI — audit and proposal

A proposal, never authority (§6 of `AGENTS.md`). `MINI.md` stays the
specification of record. The person's word in conversation outranks every
sentence here. Nothing in this file is agreed until the person says so, in
words or by marking it.

## What you have today

~3,300 lines of screen (`src/ui/*`) wired to a ~1,000-line app shell
(`src/runtime/ui.ts`), on a domain/runtime foundation that *was* rebuilt
against the confirmed intent this session (Brain, handles, collapse, frozen
projection, state block, wakes — slices one and two). 109 tests. Of those,
the UI suite (`frame`, `screen`, `ui`, `context-tree`, `input`, `launcher`)
is the part with no confirmed person involvement at any step: `docs/ui-plan.md`
records every screen decision as already taken by the agent ("Decisions
already taken"), none of it confirmed by the person.

## What the spec fixes, and what it leaves open

`MINI.md` §8 fixes: Pi TUI alt-screen; three tabs (Chat, Brain, Context); no
palette, settings screen, or drawer; the Context tab is the real prompt with
a fold tree; schema views and real views; fixed header, scrolling body, fixed
footer; one row and one cell of padding; always-visible token bar with the
real window as denominator, the budget marked, and an estimate glyph before
the first measured request.

It is silent on everything that makes or breaks the feel: the keymap beyond
tools, the meter's exact glyphs and colours, the fold ergonomics, what an
idle screen says, what "ugly" would mean here. All of that was filled in by
the agent.

## What is wrong today (defects, not taste)

1. **The injected state block is dressed as the person.** `prompt-tree.ts`
   labels every `user`-role message `Person · you` and consumes one Chat
   record per such message, in order. The block therefore (a) appears as a
   second Person message, and (b) pairs with the wrong Chat record — `e` on
   that row would open an unrelated record for editing. `MINI.md` §6.2
   forbids exactly this.
2. **Tool results are named with the raw `tool_call_id`.** Tool results carry
   no name on the wire; the assistant `tool_calls` in the same payload have it.
   Nothing indexes them.
3. **Tools render after the last message.** The tree preserves the payload's
   JSON key order (`{model, messages, tools}`). Sibling-field order is not an
   order the model "sees"; the tab presents an artifact as if it were
   information. Where tools belong is a decision nobody has made.
4. **The pre-first-request Context tab shows the projection** marked
   `unconfirmed`. It is the only honest option without a request, but it is
   also unreviewed filler presented as the prompt.

## What survives the gut (recommendation)

- The domain/runtime layer, untouched: Brain, handles, collapse, projection,
  state block, wakes, prefill, prompt-store. This is the part that is
  actually spec-driven and tested.
- One sanctioned idea from the current screen: the single actions table
  (`src/ui/actions.ts`) — the closest thing built to the posting philosophy
  (keybinding bar and references read one list). Keep the idea, re-derive the
  entries.
- The token bar's spec'd behaviour (real window denominator, budget mark,
  estimate glyph). Keep the behaviour; restyle freely.
- Tests as infrastructure; the UI assertions get rewritten to the new frame,
  not patched in place.

## The gut, sliced

- **G1 — Context tab truth.** The state block is labeled as itself and is
  excluded from Chat pairing; tool results are named from the same payload's
  assistant `tool_calls`; Tools placement becomes an explicit, documented
  choice instead of JSON order; the `unconfirmed` state is made explicit
  rather than dressed as the prompt. ~150 lines and tests. Can land now.
- **G2 — The frame teardown.** Walk `MINI.md` §8 against `src/ui/*` line by
  line; keep what it mandates, rebuild the rest minimal (one accent, real
  keyhint bar, overlays for detail and help, no bespoke layout machinery);
  delete what fails the walk — `docs/ui-plan.md`, the old hint copy, the
  redundant render paths, anything presenting itself as confirmed that
  nobody confirmed.
- **G3 — The confrontation list.** Every UI decision the agent took is listed
  in a doc — tabs or not, keymap, meter glyphs/colours/denominator, estimate
  marker, fold keys, empty states, idle marker, density, padding, the idle
  spinner — each marked confirm / change / delete. The person annotates it in
  one pass; the marks go into `docs/intent.md` (or `MINI.md`, amendments are
  the person's).
- **G4 — The rest of the project, same treatment.** Every other module
  audited against MINI/intent with the same page: what is confirmed, what is
  derived, what is unverified. Nothing survives by default; it survives by
  matching the spec or by the person's mark.

Order: G1 immediately; G3 before G2 (taste cannot be guessed, only marked) —
or G2 built by my recommendation with every choice flagged for veto, if the
person says "go". G4 last, but it starts the moment the shape of G2 lands.

## The decision this needs

One of: mark this file up; or say "go with your recommendation" and the
recommendation lands in order (G1 → G3 doc → G2 by recommendation → G4).
Re-slicing, vetoes, and amendments to `MINI.md` are the person's to make at
any point; this file is not the spec.
