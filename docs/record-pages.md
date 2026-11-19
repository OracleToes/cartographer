# Record pages

Stage: make Enter open a Brain or Context record whole, so a row that ends in
`…` can be read.

## What the person hit

> "in the context menu, i tried to open the rules so i can see what's in it, it's
> trailing off with a ... and it returns the error: R1 is selected. Enter opens
> items on the Chat tab."

`R1` is the Carto rules block: eight lines of protocol text that the model is
sent on every turn. On Context it was one row, cut at the terminal width, and
Enter refused because the previous stage's `openSelected` only had a case for
Chat. The footer message was not a view of anything.

Two mistakes are recorded here because both are the same class of error.

1. **A summary was treated as the record.** A list row is a summary by design.
   Nothing showed the rest.
2. **A message was written where a view was needed.** `openSelected` announced
   the selection instead of opening it, and the announcement claimed a
   restriction ("Enter opens items on the Chat tab") that no document made. The
   restriction was an artefact of the code written one stage earlier, not a
   decision anyone made.

## How it works

A record page **replaces the body**. It is not an overlay.

The reason is the same one recorded in `docs/reference-overlay.md` from the other
side: a record can be any length, and the body is the one region Pi TUI already
lays out and scrolls. An overlay would need its own scrolling — a `ScrollView`
there renders unbounded, so the alternative is a window written by hand — and a
centred or tall overlay covers the token bar, which the person requires to stay
visible. Swapping the body's text keeps the bar, the status row, and the footer
exactly where they are for a record of any length.

| File | Change |
| --- | --- |
| `src/ui/detail.ts` | New. `recordDetail(tab, view, selected)` projects a record; `recordDetailRows` wraps it. |
| `src/ui/frame.ts` | `Detail` gains `"record"`. The flat frame adds nothing for it; the footer names the page keys. |
| `src/runtime/ui.ts` | `paint()` draws the page in the body; `openSelected` opens it on every tab; `j k g G` scroll the page. |
| `src/ui/body.ts` | A multi-line Context block says `+7 lines` beside its cost, so the `…` is explained. |
| `src/ui/actions.ts` | `listing()` and `recordOpen` gate the actions, so the footer and `?` tell the truth in both states. |

## Three defects the tests passed and the probe caught

The tests were green at `d785246`. The screen still had three problems.

1. **`↓ end · Ctrl+End` sat on screen permanently.** Pi TUI draws its
   jump-to-end label whenever a follow-end view is not following. `showDetail`
   used `scrollTo(0, { disableFollow: true })`, and for a page shorter than the
   viewport that means "not following" with nothing to jump to. A plain
   `scrollTo(0)` leaves follow on when the page fits and turns it off by itself
   when the page is longer.
2. **The page printed the same key hint twice** — once on its last row, once in
   the footer. The page no longer prints keys; the footer owns them.
3. **`j k` moved a selection that was not on screen.** The page said `j k scroll`
   in its own text, but the key handler moved the hidden list behind it. A key
   that changes something invisible is the defect this screen keeps producing.
   `j k g G` now scroll the page, and the action table says so.

## The rule this stage leaves behind

**Gates belong on actions, not on the footer.** The footer, the `?` reference,
and the key handler all read `available(context)`. When `move` and `ends` did
not know a page was open they advertised keys that no longer meant what they
said, and the footer printed them anyway. Two of the three defects above are
that one mistake: a second place that knew the keys, and the two places drifting.

## Not done in this stage

- A page has no handle for paging with `PageUp`/`PageDown` of its own; Pi's
  primary viewport keys already scroll it, but the scroll is not asserted in a
  test.
- The Chat edit overlay still shows keys rather than the text it edits.
