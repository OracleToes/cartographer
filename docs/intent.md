# Stated intent

The person's own words, and the decisions that follow from them. This file is a
requirement record, not a proposal: when it and a plan document disagree, this
file is right.

## 2026-11-16: use Pi, and stop rebuilding the terminal layer

> "you didn't record these three dependencies in the MINI document ... so i think
> it's highly likely you're trying to rebuild a bunch of terminal UI shit from
> scratch. don't apologize for it ... we need to strip out all the hand rolled
> bullshit UI that "you" made and use the actual stuff pi-tui and the other
> dependencies ALREADY DO for us"

And, when the scope was put to them:

> "full rebuild now. and you need to record my stated intent in the docs folder."

### What must be true after this

- The screen is a Pi TUI component tree. Layout comes from `VStack`, `HStack`,
  `ScrollView`, and `Box`. Carto does not lay out rows by hand and does not
  paint three pre-joined strings into three `Text` components.
- Anything Pi TUI already provides is used, not re-implemented: word wrapping
  (`wrapTextWithAnsi`), truncation (`truncateToWidth`, `TruncatedText`),
  scrolling and paging (`ScrollView`, `TuiAltScreen` viewport actions), the
  animated indicator (`Loader`), the editor (`Editor`), overlays
  (`tui.showOverlay`), and key parsing (`matchesKey`, `Key`).
- Carto's own code is limited to what Pi does not provide: the Brain, the
  context projection, handles, product tools, and the *content* of the three
  tabs. Content generation may return cells; it may not fake a layout.

### Reference

`MINI.md` § "Use Pi, do not duplicate Pi" already says the version of this:
Pi TUI provides alternate-screen rendering, focus, editors, scrolling, input,
and mouse support, and Carto "does not implement ... a generic terminal
editor". The failure was not that the rule was absent; it was that the rule was
applied to the *editors* and not to the *layout*.

## 2026-11-16: the screen is the feedback channel

> "I have such an emphasis on the UI because that is how i assess how the agent
> is performing and give you usable feedback. the shared brain of the whole
> system is how i let you know what the agent is thinking, doing, seeing, etc
> and how we can iterate on it."

The consequences, which outrank surface polish:

- The screen must show enough of the agent's reasoning, tool calls, and shared
  Brain state that a person can judge whether the agent is working correctly.
- A defect that hides state (a header that scrolls away, a menu that opens off
  screen) is not cosmetic. It removes the person's only instrument.
- The spec's completion criteria are the target, not a wish list. Anything in
  `MINI.md` that is missing gets built.

## 2026-11-16: the header must never move

> "when it gets long enough, the header UI with the tabs and info about the
> session get pushed off the top and disappear, and even scrolling back up does
> not recover them, we need the scrollable content to be distinct from the menu
> systems."

- The chrome, the tabs, the token bar, the input box, and the footer are fixed
  regions. Only the body scrolls.
- The cause was measured, not guessed: a `Text` with empty content renders zero
  lines, so every chrome row measured height 0 and `grow: 1` gave the body the
  whole viewport. Fixed regions are now declared with an explicit `basis`.
- "Distinct from the menu systems" also means a reference opened with `?` or
  `a` is not scrolled with the transcript and does not depend on the body's
  scroll position to be readable.

## 2026-11-16: Enter

Asked whether Enter opens an item or opens the chat box, the person replied:

> "is there overlap for actions? i thought Enter was to open an item, but now it
> opens the chat box?"

and, on what the behaviour actually was:

> "what is the actual behavior now???"

### What it actually was

`src/runtime/ui.ts:448` bound `data === "i" || matchesKey(data, Key.enter)` to
one action. So in Navigate mode Enter and `i` were the same key: Enter opened
the input, and it never opened an item. Opening a Chat item was `e`, and
expanding a live item was `o`. No `MINI.md` line ever bound Enter in Navigate
mode. The binding was a port artefact.

### What it must be

- **Enter in Navigate mode opens the selected item.** A Chat item opens its
  detail; a live item expands its disclosure.
- **Enter in the input box sends.** That is the only Enter `MINI.md` ever
  specified, and it is Pi's `Editor` submit.
- **`i` opens the input** and nothing else.
- One key, one meaning, in one mode. A key that does something different
  depending on what is selected is the defect, not the feature.

## 2026-11-16: the UI must be usable before the agent can be judged

> "the result was pretty bad. it made a ledger entry but it failed on all the
> other calls, the UI is not in a state where i can give you usable data on its
> output yet."

So the order of work is: a screen that shows state truthfully, then the agent
loop judged through it. A real-model run is not evidence until the screen can
report what happened.
