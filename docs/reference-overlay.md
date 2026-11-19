# References are overlays

Stage: move `?`, `a`, and the Chat edit detail out of the transcript and onto
Pi TUI's overlay layer.

## Why

A reference is not part of the transcript. It was appended to the body, which
meant two defects the person had already named:

- It was reached by scrolling, so a reference could be opened off screen and its
  title never seen.
- Opening it moved the body, because the code pushed the transcript to its top
  so the reference would be readable. The person's own complaint — "the header
  gets pushed off and scrolling back up does not recover them" — is the same
  defect in a smaller form: content that is not the transcript was living in the
  transcript's scroll space.

`MINI.md` already separates them: the chrome is fixed, the body scrolls, and a
reference belongs to neither.

## What changed

| File | Change |
| --- | --- |
| `src/ui/overlay.ts` | New. `ReferenceOverlay` (a `Component`), `referenceRows`, `referenceMaxHeight`. |
| `src/ui/frame.ts` | The body no longer carries a reference. `detailLines` remains as the flat renderer for `renderFrame`. |
| `src/runtime/ui.ts` | `showDetail` calls `tui.showOverlay` and holds the handle; the body is not scrolled or re-followed. |
| `test/frame.test.mjs` | The menu-in-the-body assertion is replaced by two: the flat frame agrees with the shared source, and the overlay is one row per line with its summary first. |

## Two Pi TUI facts this stage rests on

Both were read out of `@earendil-works/pi-tui` 1.5.2, not assumed.

1. **An overlay is composited, not laid out.** `showOverlay` renders the
   component at a fixed width, clips at `maxHeight` from the bottom, and
   composites the rows. `ScrollView` does not clip itself; `renderLayoutFrame`
   slices it. A `ScrollView` inside an overlay renders its whole document, so a
   `ScrollView` is the wrong tool there, and a hand-written window would be a
   scroll bar built from scratch. The overlay therefore renders every row and Pi
   clips it.
2. **The clip takes the bottom.** That is why the summary row — what this is,
   how many rows it did not show, and the key that closes it — is the **first**
   row. A footer would be the first thing a short terminal lost.

## Where it opens

Not centred. A centred overlay covers the token bar, and the person's rule is
that the bar is always visible. A reference opens in the **body's band**: from
`CHROME_ABOVE` (blank, title, rule, status, bar) to the footer rule, full-bleed
across the terminal width. Two defects were seen on a real terminal and fixed
before this was written down:

- Centred, it covered the bar. The bar is not negotiable, so the reference moved
  into the body's band instead.
- Inset by one column, it left a column of transcript showing down each side, and
  the right-hand scroll column read as corruption at the edge. The body runs
  full width, so the reference does too.

## What owns the keyboard

While a reference page (`?`, `a`) is open it owns the keyboard. `?`/`a` close
it, `Escape` closes it, `1`/`2`/`3` switch tab and close it, and everything else
is swallowed: `j` over a covering reference would move a transcript the person
cannot see.

The Chat edit reference is the exception. Its whole content is a list of keys
that work on the selected Chat (`i`, `d`, `D`), so swallowing them would make its
own text false. It closes on the first key, and that key then does its job.

## Not done in this stage

- The Chat edit reference is three hint rows. It does not yet *show* the Chat
  text being replaced, which is what the person asked to see.
- `scrollToEndIndicator` is passed to `TuiAltScreen` but has not been seen on
  screen yet.
- The overlay has been eyeballed in a real terminal at 22×100: the bar stays
  visible, `j` does not move the body, and `Esc` restores the body exactly.
- The body still repaints underneath a covering reference. It is invisible, and
  removing it would mean teaching `paint()` to skip the body, which is not worth
  a branch yet.
