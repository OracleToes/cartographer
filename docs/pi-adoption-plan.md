# Pi dependency adoption plan

A plan, not authority (`AGENTS.md` §1.4). It covers where Carto hand-rolls
behaviour that `@earendil-works/pi-tui`, `@earendil-works/pi-durable`, or
`@earendil-works/pi-ai` already provide, ordered from mechanical cleanups to
runtime migrations. Items that involve UX or product taste are deferred to the
end — stop and ask `OracleToes` before implementing any item in Part B.

Each stage ends with a single `npm test` (≤ 10s total) and a push (`AGENTS.md`
§4). Status is updated here as stages land: `open`, `done`, or `blocked`.

---

## Part A — Straightforward stages (no UX trade-offs)

### Stage 1 — `pi-tui` text utilities, dead scroll state, and `HelpPanel` scroll

**Status: open.**

**What is hand-rolled.**
- `src/ui/tokens.ts:103–107` implements `padLine(str, width)` over `visibleWidth`
  and `truncateToWidth`. `pi-tui`'s `truncateToWidth(str, width, "...", true)`
  already truncates and pads in one pass while leaving exact-width lines intact.
- `src/ui/preview.ts:30, 452–453` strips ANSI escapes with `/\x1b\[[0-9;]*m/g`
  (missing OSC/APC sequences) instead of `stripTerminalSequences` from
  `@earendil-works/pi-tui`.
- `src/ui/archive-view.ts:68, 137–156` maintains a `private scrollOffset = 0`
  that is reset on navigation and never read (`archiveScroll = new ScrollView(archiveView)`
  already owns scrolling).
- `src/ui/help-panel.ts:29–46, 75` hand-rolls `private offset = 0` and
  `rows.slice(this.offset)` with unbounded `offset += 1` instead of using
  `ScrollView`.

**Plan.**
- Delegate `padLine` in `src/ui/tokens.ts` to `truncateToWidth(str, width, "...", true)`
  (preserving its exact exported signature and exact-width test coverage).
- Replace the ANSI-stripping regexes in `src/ui/preview.ts` with
  `stripTerminalSequences` from `@earendil-works/pi-tui` (keeping the APC
  placeholder strip only if `stripTerminalSequences` does not cover it — verify
  against `pi-tui/dist/utils.js`).
- Remove the unused `scrollOffset` field and assignments from
  `src/ui/archive-view.ts`.
- Mount `HelpPanel`'s rendered rows inside a `ScrollView` (keeping `f1`/`esc`/`q`
  close and `j`/`k`/`up`/`down`/`pageUp`/`pageDown` scrolling via the
  `ScrollView`'s `scrollBy`).

**Verification.** Existing `test/ui-views.test.mjs` coverage for `padLine`,
`ArchiveView`, `preview`, plus a scroll-bounds check on `HelpPanel`.

---

### Stage 2 — `pi-tui` `Input` + `fuzzyFilter` for filter bars in Atlas, Ledger, and Tree

**Status: open.**

**What is hand-rolled.**
- `src/ui/atlas-view.ts:64–82`, `src/ui/ledger-view.ts:57–75`, and
  `src/ui/tree-view.ts:304–325` each hand-roll a filter input (`this.filtering`,
  `this.filterText`, `backspace` slicing, `data.length === 1` appending) and
  plain `.includes()` matching. This misses cursor movement, word delete, paste,
  and Kitty protocol printable decoding, and duplicates logic three times.
- `pi-tui` already provides `Input` (already used in `src/ui/palette.ts`) and
  `fuzzyFilter`.

**Plan.**
- Give `AtlasView`, `LedgerView`, and `TreeView` an `Input` instance for `/`
  filter mode (preserving `/` to open, `Enter` to commit filter, `Esc`/`Ctrl+C`
  to clear and exit, and `isFiltering()` so command keys stay suppressed while
  typing).
- Use `fuzzyFilter` from `@earendil-works/pi-tui` to filter nodes/entries/tree
  rows while keeping empty-query order unchanged.
- Keep the header rendering compact and consistent with each view's existing
  header row.

**Verification.** Add/update unit tests in `test/ui-views.test.mjs` covering `/`
filtering, fuzzy match, `Enter` commit, and `Esc` cancel on Atlas, Ledger, and
Tree.

---

### Stage 3 — `pi-durable` `background: true` for `SleepTask` + `conversation.waitForIdle`

**Status: open.**

**What is hand-rolled.**
- `src/runtime/live-session.ts:273–291` hand-rolls `waitForRunEnd` by opening a
  `LiveDoc` watch and waiting for `run === undefined`, because `SleepTask`
  (`src/runtime/tools.ts:508`) is created with `{ ownership: { kind: "conversation" } }`
  (ordinary ownership) rather than `{ ownership: { kind: "conversation" }, background: true }`.
- `pi-durable` provides `TaskOptions.background: true` specifically so
  conversation-owned background tasks are excluded from
  `conversation.waitForIdle(context)` and ordinary aborts.

**Plan.**
- Pass `background: true` when creating `SleepTask` in `src/runtime/tools.ts`.
- Audit every `abort()` and wake-cancellation call site (`src/runtime/live-session.ts`,
  `src/runtime/headless.ts`, `src/ui/app.ts`) so that:
  - submitting a person message still aborts the active `SleepTask` explicitly
    (already done via `abortTask(id)` + `RestDoc` invalidation);
  - collapsing / interrupting a session passes `{ background: true }` where
    background rests should be torn down with the generation.
- Replace `waitForRunEnd` with `session.conversation.waitForIdle(BACKGROUND_CONTEXT)`
  (checking first whether legacy non-background `carto.sleep` tasks on disk from
  older stores require a compatibility guard or can be cleanly migrated).

**Verification.** Existing timed-rest, wake-interruption, and auto-collapse
tests in `test/01-live-session.test.mjs` and `test/04-auto-collapse.test.mjs`
must pass unchanged and within the 10s suite budget.

---

### Stage 4 — `pi-durable` `conversation.watch()` + `ConversationTranscript` in `startLiveWatch`

**Status: open.**

**What is hand-rolled.**
- `src/ui/app.ts:1636–1668` watches only `LiveDoc`, and on **every** streaming
  update calls `sessionTranscript(state.session)` (which runs
  `conversation.context()` over SQLite) plus a 400ms-throttled full
  `rebuildTranscript()`.
- `pi-durable` already ships `conversation.watch(context, window)` returning
  `ConversationView` (both the entry window and built-in docs including
  `pi.live` in one folded stream) and `ConversationTranscript` for O(new)
  incremental transcript merging.

**Plan.**
- Replace `harness.watchDoc(LiveDoc, ...)` in `src/ui/app.ts` with
  `state.session.conversation.watch(BACKGROUND_CONTEXT)` paired with
  `ConversationTranscript`.
- Cache the landed `sessionTranscript` entries (and their prompt handles) in
  memory; re-read `conversation.context()` only when `ConversationTranscript`
  observes a newly committed entry (including `carto.apply-now` edits) or after
  a collapse, not on every streaming token delta in `docs["pi.live"]`.
- Update live streaming cards directly from `view.docs["pi.live"]` against the
  cached landed handles, removing the 400ms polling timer and redundant SQLite
  reads during streaming.

**Verification.** Verify live streaming cards, handle continuity between live
and landed cards, `apply-now` omissions, timed wakes, and collapse handoff in
the existing suite.

---

## Part B — Nuance & taste (ask `OracleToes` before implementing)

Do not start any item below without confirming the preference first.

### Decision 1 — Split-pane `ScrollView` for Atlas and Ledger detail panes

- **Where:** `src/ui/atlas-view.ts`, `src/ui/ledger-view.ts`, `src/ui/app.ts`.
- **What pi-tui offers:** `HStack` + a dedicated `ScrollView` for the right-hand
  detail pane, replacing manual `scrollOffset`, hardcoded `maxLines = 22`,
  manual wheel `±3`, and the `⋯ ▲/▼` footer.
- **Why it needs taste:** Changing from one composite component inside one
  `ScrollView` to two real panes changes narrow-terminal fallback (`width < 72`),
  how list vs. detail focus is shown, where mouse-wheel events scroll, and
  whether the `⋯ ▲ N above ▼ M more lines` indicator is replaced by a scrollbar.
- **Question to ask:** Do you want Atlas and Ledger refactored into real split
  `HStack` + per-pane `ScrollView`s (dropping manual `scrollOffset` and the
  22-line cap), or kept as single-component views?

### Decision 2 — Command palette (`src/ui/palette.ts`) vs. `pi-tui`'s `SelectList`

- **Where:** `src/ui/palette.ts`.
- **What pi-tui offers:** `SelectList` (built-in cursor, paging, and mouse
  clicks; `palette.ts` already exports `selectTheme: SelectListTheme`).
- **Why it needs taste:** `Palette` currently draws non-selectable uppercase
  group headings (`THE TRANSCRIPT`, `ANYWHERE`, …) with right-aligned keycaps,
  which `SelectList` does not natively support. Using `SelectList` means either
  flattening headings into row descriptions (e.g. `group · key`) or keeping
  `Palette`'s custom renderer.
- **Question to ask:** Keep `Palette`'s grouped-heading layout as-is, or switch
  to `SelectList` (gaining mouse clicks/paging at the cost of inline group
  headings)?

### Decision 3 — Token estimation (`src/domain/estimate.ts`) vs. `@earendil-works/pi-ai/utils/estimate`

- **Where:** `src/domain/estimate.ts`, `src/domain/state-block.ts`,
  `src/runtime/live-session.ts`, `src/ui/context-bar.ts`.
- **What pi-ai offers:** `estimateTextTokens`, `estimateMessageTokens`,
  `estimateContextTokens`, and `calculateContextTokens` (3.5 chars/token, image
  estimates, structured assistant/tool-call handling, and last-assistant-usage +
  trailing-message math).
- **Why it needs taste:** Switching from Carto's 4 bytes/token JSON estimate to
  `pi-ai`'s 3.5 chars/token message estimator shifts all displayed `~N tok`
  numbers (~14% higher) and slightly changes when estimated-only fill crosses
  `collapseWarningPercent`. Carto's 3-way `system / transcript / toolWork` split
  still stays in Carto either way.
- **Question to ask:** Switch `estimate.ts` (and last-usage + trailing math) to
  `@earendil-works/pi-ai/utils/estimate`, or keep Carto's 4-bytes/token
  estimator?

### Decision 4 — Unused `TuiAltScreen` viewport features & `Markdown`

- **Where:** `src/ui/app.ts`, `src/ui/transcript.ts`, `src/ui/atlas-view.ts`,
  `src/ui/ledger-view.ts`.
- **What pi-tui offers:**
  1. Built-in alternate-screen search (`searchMatchStyle`,
     `searchCurrentMatchStyle`, `tui.altScreen.search`).
  2. Clickable `scrollToEndIndicator` on the primary follow-end `ScrollView`
     when scrolled away from the bottom.
  3. `Markdown` component for rendered headings, lists, bold/italic, code
     blocks, and tables.
- **Why it needs taste:** Each changes visible chrome, keybindings, or text
  styling (e.g. search keybinding vs. `/` filter in books, a floating jump-to-end
  pill in the transcript, rendered Markdown vs. plain wrapped text).
- **Question to ask:** Which (if any) of built-in alt-screen search, the
  scroll-to-end indicator, and `Markdown` rendering do you want wired in?

---

## Explicitly NOT migrating (verified not duplicated)

Recorded here so later passes do not re-audit these:

- **`src/ui/clipboard.ts`** — `pi-tui`'s `getNativeClipboard()` only reads
  (`getText`/`getImage`), never writes; `TuiAltScreen`'s default write is bare
  OSC 52. Carto's verified native writer (`wl-copy`/`xclip`/`xsel`/`pbcopy`/`clip.exe`)
  is intentionally injected via `copySelection`.
- **`src/ui/tokens.ts` (`fillLine`)** — `pi-tui`'s `applyBackgroundToLine` does
  not re-arm surface background after inner `\x1b[0m` / `\x1b[49m` resets.
- **`src/ui/frame.ts` (`Row`, `Column`, `Fill`, `Inset`)** — `Row`/`Column`
  subclass `HStack`/`VStack` to avoid O(depth) measure re-renders during
  streaming; `pi-tui`'s `Box` only supports symmetric padding and one background.
- **`src/runtime/brain-store.ts`** — already built on
  `@earendil-works/chord/sqlite/node`; single-row overwrite-in-place is required
  by `SPEC.md` §4.2 (no audit trail / tombstones).
- **`src/runtime/tools.ts` & `src/runtime/carto-extension.ts`** — already wrap
  `pi-durable/tools` (`read`, `edit`, `write`, `bash`) and
  `pi-ai/utils/overflow` (`isContextOverflow`, `isRecoverableLength`).
- **`src/runtime/stream-freeze.ts` & `src/runtime/model-telemetry.ts`** —
  live HTTP-body pause (`^v`) and llama.cpp `prompt_progress`/`timings` are
  outside `pi-durable`/`pi-ai`, and already hook `pi-ai`'s `onPayload`,
  `onResponse`, and `onProviderStreamEvent`.
