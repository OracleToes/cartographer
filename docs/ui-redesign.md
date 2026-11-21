# The old UI-redesign document, applied — kept honest

*Record of what was taken from the main-era `prompts/UIDesignPrompt.md`
(deleted in `1c233e3`, recovered from git history at the person's direction,
2026-11-20) once it was held against Posting's design philosophy (the
person-given reference, `docs/ui-proposal.md` §2) and the rebuilt UI this
repository actually has. This is an application record, not an authority:
MINI.md binds, and the person's marks win wherever this disagrees with them.
Where the old prompt says "redesign the backend into standardized contracts,"
the rebuilt runtime already has explicit boundaries and typed failures; the
pillars below were applied to the interface, and only there.*

## The document, in one line each — and where it landed

**1. Consistency (one design system).**
Applied, as the shape it already had: every colour is a semantic token in
`src/ui/tokens.ts` (roles only — surfaces, text, interaction, feedback;
nothing else picks a colour). The one inconsistency that regressed during
R5a/R5b was fixed by extraction, not by addition. Consistency across screens
is the modes-not-tabs shape itself: one header row, one footer idiom
(context-sensitive keys, Posting's), one fold idiom (every text-bearing
block is a card or a row — this session's display work), one frame.

**2. Component reusability (a shared library, no reinventing).**
Applied with the standing dependency-first rule: the library is
`@earendil-works/pi-tui` (stacks, scroll view, editor, overlays) plus the
hand-rolled minimum — `TranscriptView`, `HeaderView`, `FooterView`,
`Sidebar`, `TokenBarView`. No third-party UI package, no parallel widget
vocabulary.

**3. Global keybindings (one navigation model).**
Applied the vim-first, Posting-second, agent-decided-third policy
(`docs/ui-proposal.md` §10): vim motions in lists, `ctrl+o` jump mode
everywhere, `ctrl+p` palette summoned never standing, `/` to filter, `esc`
back. `/help` lists exactly what works. Nothing binds a key that is not
listed there or in the footer.

**4. Layout structure (persistent shell).**
Applied: fixed header (project · generation · model · active window), one
dense main area, the token bar always above a context-sensitive footer, one
cell of padding on every edge so the chrome never touches the terminal edge
(this turn). Chat is the boot view (R5a); the Brain views, Atlas and Ledger
two-pane (R5c), and the Context surgery view (R5d, read-only) have landed in
the same tree, so nothing is honestly absent that was supposed to exist —
the one remaining gap is surgery edits beyond delete-with-Now, which is
honestly absent.

**5. Whitespace & padding.** Applied this turn: one cell on every edge
(`Spacer` margins; the layout solver handles resize). No border glyphs —
the padding is the mark asked for, and a border would shout instead.

**6. Responsive.** Applied structurally: stacks distribute by basis/grow,
`minSize` guards the main area, every text row goes through
`truncateToWidth`, sidebars collapse behind `ctrl+h` on small windows.
Untested at absurd sizes; that is the person's to hit and report.

**7. Information density.** Applied as Posting does it: one dense screen,
nothing stands idle — foldable cards default folded when landed, open while
streaming.

**8. Completeness ("every backend capability is reachable").**
**Rejected as stated, and recorded.** The rebuilt Carto surface is the
confirmed §10a list — nothing more (`docs/rebuild-slices.md` R3). Exposing
every runtime internal would contradict MINI.md. Completeness here means:
the confirmed surface is fully usable, and absence is announced (a jump to an
unbuilt view flashes the slice that owns it; `/help` says what exists).

**9. Edge cases & feedback.**
Applied where the spec allows: empty state on boot (the welcoming empty
transcript), live feedback (streaming cards, `working…` in the footer, the
token bar), errors as quiet status lines with the reason named. **Not
applied: confirmation modals for destructive actions.** Delete in the Brain
is one step by the person's own doctrine (single-step, no undo,
person-created records indistinguishable). An interposed modal would argue
with the spec. Approval gating is not a UI feature in this build by design.

**10. Decoupling (TUI renders, backend decides).**
Upheld: views render projections (`tokens.ts`, `transcript.ts`, `sidebar.ts`,
`token-bar.ts` read values handed to them); all Brain operations live in
`runtime/`; the workspace rebuilds from sources of truth on every settle
and never mutates the Brain from the view.

**11. Standardized data/error contracts.**
Upheld at the tool boundary (unknown handles are explicit errors; tool-call
failures render as `· failed` on the card; slash-command failures land as
status lines). No `any`-shaped UI crashes are known; unproven claims are not
made.

**12. Non-blocking UI.** Upheld by construction: the render loop is pi-tui's;
session and Brain calls are async; interruption is `ctrl+x` and it is the
run that stops, not the UI.

## What was not imported

- The prompt's Phase-1-through-6 ceremony against a backend rewrite. The
  rebuilt backend was re-derived last week against MINI.md; re-refactoring it
  under a generic prompt is not the person's ask.
- Modals, toasts, a component theme engine, "settings screens": Posting does
  not have them either; the palette + status lines are the feedback channel.
- Anything touching MINI.md §8/§9/§10a semantics. The person's marks govern.

## Standing consequence

Every display change from here is judged by three checks: one scroll owner
(the page), honest numbers (measured vs estimate, never invented), and no
chrome touching the terminal edge. This document is the citation for those
in reviews; it is not a license to add UI.
