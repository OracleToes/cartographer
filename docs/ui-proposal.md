# R5 — the Carto workspace: proposal

*Draft for the person to mark up, 2026-11-20. Not authority. Nothing here is
built, and nothing is binding until the person marks it. Where the person and
this document disagree, the person wins.*

## 1. What the screen is for

Carto is a person↔agent workspace. The agent works; the person watches, steers,
and keeps the books. The screen has three jobs, which is why the naive "three
tabs and done" oversimplifies:

1. **Watch the agent work.** The transcript, and nothing between the person and
   it. The only person-facing text is the agent's `chat` tool calls (MINI.md
   §10a) — never model prose.
2. **Garden the context.** The **Context view is the special one** — "the open
   brain surgery section": see everything the agent thinks and sees, and
   surgically remove, reorder, edit, and add content into it. It is an accurate
   representation of everything the agent sees, in a structured, editable
   format. Not a report about the context; the context itself, laid open.
3. **Read the books.** Atlas, Ledger, Chat, pins, wakes — structured views of
   the Brain, by handle.

The token/prefill bar is required, always visible. Everything else about the
chrome — frame, tabs, palette, sidebar — is a proposal, and Posting is the
reference, not a port target.

## 2. What we take from Posting (and what we do not)

Posting (`darrenburns/posting`, person-given; `AGENTS.md` §2) is a keyboard-first
TUI HTTP client whose layout is one dense screen: sidebar, one primary work
area, a context-sensitive footer, jump mode, command palette, request tabs,
37 themes. Functionally it is unrelated to Carto. As a *design of a terminal
tool a person lives in*, it is the strongest reference we have, and the person
directed: use its design philosophy and even its structure — pi-tui first
where it does what we want, hand-rolled the minimum to reach Posting's
elegance.

Concretely, what we adopt:

- **Keyboard-first, everything focusable.** Every region reachable by keystroke;
  the mouse works too (click, scroll), but the keyboard is the design.
- **Jump mode.** One key (`ctrl+o`); labels appear on every jumpable region;
  one or two keystrokes and focus lands there. Posting's QWERTY-placed labels
  are the idea to copy verbatim: labels sit where their regions are.
- **Context-sensitive footer.** The bottom row shows the keys that work *where
  you are*, with names. The person can always see the next three moves.
- **Command palette as an overlay** (`ctrl+p`) for everything not on a key.
  MINI.md §8 says there is no permanent palette — correct, and consistent:
  the palette is summoned, never standing.
- **A single dense screen over a maximized grid.** The request/response pair
  split is Posting's analogue of our **Context view's two panes** (the parts
  rail and the part's content).
- **Themes as semantic tokens** (Posting's token vocabulary; our deleted
  main-era `tokens.mjs` had the same shape — surface/text/border/feedback —
  and was right about that much).
- **Per-entity tabs with a dirty dot** — adopted for nothing yet; noted.

What we do not adopt: Textual/Python (different stack), the HTTP request
domain, the collection browser (our sidebar is the Brain index — different
content), Posting's settings screens (person deferred prompt editing; there is
no settings surface at all in this build).

## 3. pi-tui first: what we get for free

`@earendil-works/pi-tui` ships, ready to compose:

| Need | pi-tui provides | Use |
| --- | --- | --- |
| Alternate screen + frame loop | `TuiAltScreen`, `tui.ts` (Container, Overlay bounds), render loop | yes |
| Layout | `HStack`/`VStack`/`Box`/`Spacer`, fixed sizes, padding | yes |
| Scrolling bodies (transcript, record lists, surgery panes) | `ScrollView` (+scrollbar, scroll-to) | yes |
| Text/markdown messages | `Text`, `Markdown` (marked-based), `TruncatedText` | yes |
| Input line | `Editor` (multiline, kill ring, autocomplete) / `Input` | yes |
| Lists (palette results, record index, parts rail) | `SelectList` + `fuzzyFilter` | yes |
| Overlays (palette, jump labels) | `OverlayOptions`/`OverlayAnchor`, `MouseRegion` | yes |
| Keys | `KeybindingsManager`, kitty protocol flags, `matchesKey` | yes |
| Colour | `parseColor`, oklch/okhsl mixing, `styleText` | yes |

Hand-rolled, minimum to reach the elegance (each is small):

- **Disclosure rows / fold tree** for the Context view and record lists —
  Text rows with an explicit fold state; `▾`/`▸` markers. No tree widget
  exists; the disclosure discipline is ~100 lines.
- **The token bar** — one row, segmented (below). Pure string compositor;
  the old meter showed the shape; the new one is prettier, same honesty rules.
- **The parts rail** — per-part token accounting rendered as compact rows
  (the main-era `context.parts` accounting, redesigned as a rail instead of
  a wall of text).
- **Nothing else without the person's word.** If something is missing from
  pi-tui, it is measured before it is built.

## 4. The layout (proposed; the frame is not fixed until the person marks it)

One alternate screen. One cell of padding on every edge (the chrome never
touches the terminal edge). No permanent palette, settings, or drawer.

*(Every number in the mocks — token counts, percentages, window size, entry
counts — is illustrative, not measured. Nothing ships showing a figure that
was not derived from a real request or the active window.)*

```
┌─ carto · simpledice · gen-20261120T1530Z-aa10 ──── ByteShape · 65,536 ─┐
│ a Atlas · l Ledger · c Chat · p Pins · w Wakes │ 26 entries · 4 stale  │  ← one row, split: project+generation · model+window
├────────────────┬───────────────────────────────────────────────────────┤
│ INDEX          │  THE MAIN AREA — one of:                              │
│ ▸ Atlas    12  │   · Chat — the transcript; agent chat messages and    │
│   Ledger    8  │     person input; the run's status, interruptible.    │
│   Chat     42  │   · Context — the surgery view (§5)                   │
│   Pins      3  │   · Brain — a record list + the record, folded        │
│   Wakes     2  │     (§6)                                              │
│                 │                                                       │
├────────────────┴───────────────────────────────────────────────────────┤
│ ▤▤▤▤▤▤▤▤▤▤▤▤░░░░░░░░░░░░░░░░░░░░░  ~41,820 / 65,536 · 64% · ┊ 48k cap │  ← the token bar, always
├─────────────────────────────────────────────────────────────────────────┤
│ a atlas  l ledger  c chat  ^O context  ^p palette  ^x interrupt  ^C quit │  ← footer: keys that work here
└───────────────────────────────────────────────────────────────────────────┘
```

- **Modes, not tab chrome.** Chat / Context / Brain are views reachable by
  jump keys and the palette, Posting-style — not three fixed tabs. If the
  person prefers literal tabs (MINI.md §8's three), the same body renders
  behind them; it is a mark, not a fork. The *sidebar index* is the Brain's
  tables of contents — counts and stale badges; click/jump to open.
- **The bar sits above the footer**, always visible, on every view.
- **The header is one row** and never pushes content; generation is shown
  because it is the crash-recovery handle.
- **The footer is context-sensitive**: different keys on Chat, Context,
  and record views, in Posting's idiom.

## 5. The Context view — the surgery view

This is the deliverable of the slice that matters most. Failure modes to
avoid: a pretty report *about* the context (the old `context.parts` accounting
rows were that — correct numbers, prose shape), and an editor disconnected
from the real payload.

**What it is.** The exact, ordered contents of the next request, grouped:

```
SYSTEM  · 1 part · ~5,900 tokens                    (editable: overlay text)
  carto-rules …
  carto-context (the frozen projection; rebuilt at collapse) … ~9,800
TOOLS   · 12 entries · ~12,300 tokens · chat, atlas, ledger, pin, …
PROJECTION  · frozen at gen-…-aa10 · ~9,800 tokens  (read-only here; §6 to edit)
TRANSCRIPT  · 38 messages · ~8,100 tokens
  #1 · user · "…"                          214 tokens
  #2 · assistant · [tool: chat]            388 tokens   [▾]
  …
TOOL WORK · 21 results · ~2,600 tokens
BLOCK   · the state block, ~1,700 tokens · never removed, never shown raw
```

- **Left rail**: the parts with token counts (estimates, estimate-glyphed)
  and share; selecting a part shows its contents on the right. This is the
  main-era `context.parts` accounting, rebuilt as a rail, and it is *derived
  from the same assembly that builds the request* — one code path, no drift.
- **Right pane**: the part, foldable (leaf never folds), exact text, selectable.
- **A human view / real view toggle** for schema-shaped content (the old
  fold-tree screen had the right instinct): human = readable summary;
  real = the exact bytes that would be sent.
- **Accuracy guarantee**: the view renders what `beforeRequest` would send —
  same strip-then-append assembly, read-only. If it cannot render, the request
  cannot be sent; that is the feature.

**What you can do to it** (all as an *overlay on a frozen truth* — the Pi
store is append-only and stays so):

| Action | Keys (proposed) | Mechanism |
| --- | --- | --- |
| Remove an item from the context window | `x` | `exclude` overlay: durable entry id; consulted at payload assembly. The Brain is untouched. |
| Bring it back | `x` again | remove exclusion |
| Reorder (e.g., the person moves a file fact higher) | `<` / `>` | overlay order list; applied at assembly |
| Edit an item's text (e.g., compress the agent's ramble) | `e` | overlay text replacement for that entry |
| Insert free content at a position | `a` | overlay block, addressed as its own entry |
| Collapse now | `c` | the existing `/collapse` ceremony |

- **The overlay lives in the generation, is cleared at collapse** (like the
  pending list), and is *not* Brain state — surgery changes what the model
  sees, never what the Brain remembers. This is the honest split: the Brain
  is the books; the context is this generation's working set.
- **Removing things is cheap and reversible** (until the generation ends);
  adding things is explicit text, so nothing silently enters the prompt.
- The state block itself is never removable or editable (spec); the marker is
  never rendered. The projection is edited by editing *Brain records* (§6) —
  the projection is a view of the Brain, never edited directly.
- **Crash-safety**: the overlay is ephemeral session memory. A crash drops
  unapplied surgery — acceptable, because the Brain is untouched and the new
  generation re-derives everything; losing an exclusion is loseable, losing a
  Brain record is not.

## 6. The Brain views

Sidebar index, one list per table, records folded by handle. The projection is
rebuilt *from the same records*, so an Atlas edit here changes what the next
collapse freezes (and what the state block's Atlas lines show) — the person
sees the consequence in one place.

- **Atlas** — nodes by handle, claim on the head row, evidence + edges folded;
  stale evidence highlighted (`A5 · stale`), matching the state block's stale
  line and the projection's `[stale]` marks.
- **Ledger** — open questions/instructions first; answers folded under their
  entries.
- **Chat** — the agent's person-facing words, chronological.
- **Pins** — user layer above carry layer; each pin shows source + freshness.
- **Wakes** — armed wakes with their reason and, for time-wakes, the countdown
  (the sleep-tool wake, §11 below).
- Read-only in v1. Edit (atlas node text, ledger status, pin removal) comes
  after the person has used the lists; no gate exists until then.

## 7. The token bar (required; redesigned prefill visual)

The old `meter-bar` concept (one row: kept `▰`, reading `▨`, free `▱`, budget
mark `┊`, estimate by glyph `▤`) was the right idea in the wrong dress. Two
candidates — the person picks by eye:

**A — one row, segmented by part** (recommended):

```
▮▮▮▮▮▮▮▮▮▮▮░░▮▮▮░░░▮░░░░░░░░░░░░░  ~41.8k / 65,536 · 64% · ┊ 48k
└ system+tools ~18.2k ┘└ projection ~9.8k ┘└ work ~13.8k ┘
```

One colour per part (muted, distinguishable), estimate = hatched/muted fill,
server-measured = solid fill; the budget tick is `┊`; past the tick the free
region tints warning; past the window it tints danger. Right-aligned numbers,
always. One glance = "what is this window made of."

**B — two rows: the bar, then the breakdown line**

```
▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▤▱▱▱▱▱▱▱▱▱  ~41.8k / 65,536 · 64%
sys 5.9k · tools 12.3k · proj 9.8k · work 10.8k · block 1.7k · free 23.7k
```

More information, costs a second row; identical honesty rules either way.

Standing rules (from the token-bar decision, 2026-11-20): live bar ships;
before the first measured response it is estimate-glyphed (`▤` family); the
post-request truth is the provider's usage numbers (pi-ai surfaces them);
**no invented figure is ever shown as measured**; `prompt_progress` from
llama.cpp remains unverified — if the real server never sends it, the bar
says "reading" nowhere and that is fine. The denominator is the active
context window (min(ceiling, advertised)), never the model's maximum.

## 8. Keys (proposed; the person's to set)

Footer shows only what works where you are. Globals:

| Key | Action |
| --- | --- |
| `ctrl+o` | jump mode (labels everywhere) |
| `ctrl+p` | command palette |
| `ctrl+x` | interrupt the run (turn control §9) |
| `ctrl+c` | quit |
| type | steer the run (a person line is a steer at the next boundary — needs the person's confirmation of the binding) |

View switches via jump keys: `a` atlas · `l` ledger · `t` transcript/chat ·
`x` context · plus digits for the sidebar. Follow-up (queued after the run)
gets no default key yet — the person marks it or it gets one in the palette.

## 9. Build order (each stage ends in your hands to boot)

1. **R5a — shell + Chat view** (`TuiAltScreen`, layout, footer, jump mode,
   palette, transcript from the live session; faux-provider scripted and
   bootable). You boot it; this is also **R4's verification** — the same build
   against your llama-swap.
2. **R5b — token bar**, your pick of A/B, estimate-glyphed.
3. **R5c — Brain views** (read-only lists + folded records).
4. **R5d — Context surgery view**, read-only accurate rendering first
   (rail + panes + real/human toggle).
5. **R5e — surgery edits** (exclude → reorder → edit → insert), each behind
   its own stage so each is bootable.
6. **R5f — prefill measurement**, only if the server ever sends
   `prompt_progress`; otherwise never built (Q9/Q13.3 remain honest absences).

Everything pi-tui provides is used, not reimplemented; everything hand-rolled
is listed in §3 and is small; the `1.4k tok/s`-style invented status numbers
do not come back.

## 10. Person's marks requested

1. **Layout**: modes-not-tabs (recommended) or literal three tabs?
2. **Bar**: A or B?
3. **Sidebar**: visible by default? What's the default view on boot — Chat?
4. **Keys**: the interrupt binding; steer/follow-up bindings; any keys you
   want guaranteed.
5. **Surgery semantics**: per-generation overlay cleared at collapse
   (recommended) — confirm or change.
6. **Brain views read-only v1** — confirm.
7. Anything in §5–§8 that misreads what you want.

## 11. Confirmed since the plan was written (not open)

- **Wakes are the sleep tool's wake**: the agent calls `sleep` — with no time,
  until you wake it; with a timer, it wakes when the timer fires. Nothing
  else. (Q11.1 resolved this turn.)
- **Small-atomic-edits is prompt-only**, stated explicitly by the person;
  no structural enforcement in the edit tool. (Q8.1 resolved.)
- **The archive's `deletionMarks` are gone** — no extra legacy machinery
  unless the project needs it. (Q2.5 resolved: dropped.)
