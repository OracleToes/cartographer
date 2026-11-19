# Carto screen plan

This document records the plan for the Carto screen. It has two parts:

1. What Carto learns from Posting's UI backend.
2. The screen changes, in the order we build them.

It is a working record. `MINI.md` stays the product specification.

---

## 1. Purpose

The current screen works, but it has three defects and one gap:

- **Defect: the screen does not repaint while the agent works.** The refresh timer returns early while a local action is busy, and Pi TUI draws only when a component asks for a frame. The person must press a key to see progress.
- **Defect: a repaint can write to the Brain.** `CartoProject.view()` calls `syncHandles()`, which can commit. A view call must not write.
- **Defect: a failed repaint is invisible.** The refresh path catches errors and returns `undefined`. A lost frame looks like a frozen program.
- **Gap: there is no honest token meter.** The Context tab prints one estimate line. The person cannot see how full the model window is, or how far the server is with reading the prompt.

This plan fixes these. It also takes Posting's screen discipline: one accent, one rule, a real footer, two-row records, and a single source of truth for keys.

## 2. Decisions already taken

| # | Decision | Result |
|---|---|---|
| 1 | Bar length | The real model window (32 768). The 16 000 budget is a mark inside the bar. |
| 2 | Bar visibility | Always visible. It is part of the frame, in all tabs. |
| 3 | Estimate before the first request | Shown in a different glyph and a different style, with a `~` mark. |
| 4 | Spinner | Required. It is the frame clock while a run is active. |
| 5 | Footer | Takes the entire bottom row, with two cells of padding. |

---

## 3. What Posting teaches

Posting 3 is Go and Terma. Carto is TypeScript and Pi TUI. We do not port code. We take the structure. The useful parts are below.

### 3.1 The UI performs no I/O

`internal/ui/app.go` starts with:

> The UI never performs I/O itself. Requests are sent through the `client.Sender` passed in `Config`; collections and environments arrive as `model` values. Swapping the fake sender for a real HTTP client requires no changes in this package.

`Config` injects every outside dependency: `Sender`, `Collection`, `Store`, `Watch`, `Reload`, `OpenURL`, `Environments`, `History`, `Settings`, `UserThemes`, startup problems. Tests use `model.SampleCollection()` and a fake sender, so a screen test needs no network and no disk.

**Carto takes this.** `CartoProject` is Carto's `Config`. The screen layer reads a `ProjectView` value and calls named project operations. It does not open SQLite, call a model, or read files. This is what makes a pure render function possible.

### 3.2 One UI thread, explicit dispatch

Posting keeps all UI mutation on one goroutine. Background work comes back through `a.dispatch(func(){...})`; `onUI()` in `internal/ui/remote.go` marshals a call onto it and waits. `Session.Send` takes callbacks (`OnTrace`, `OnUpload`, `OnUpdate`, `OnAuth`) that are documented as callable from any goroutine and are marshalled by the UI.

**Carto takes this as a rule, not as a mechanism.** Browser-style threads do not exist in Node, but ordering does. The screen keeps one state object, and every mutation happens in one function. Async results set a flag; the frame function applies them. No promise resolves directly into a render.

### 3.3 Signals, and rebuild only on change

Terma state is `t.Signal[T]`. A widget reads a signal inside `Build`; a change marks the widget for rebuild. Posting is careful about the cost:

- `footer.Build` documents that it "only rebuilds by itself when focus moves".
- `focusWithin` returns a bool so "the caller only rebuilds when the answer changes, not on every focus move".
- `headingProbe` records the heading width as of the last paint, so a width change rebuilds the heading in the next frame.
- `tabView.width` exists because "layout doesn't tell widgets their size while they build, so a probe records it".

**Carto takes this.** Our frame function gets `width`, and every row is composed for that width. We keep the last width and the last text of every row; a row is only replaced when its text changes. This is how Pi TUI avoids work: `Text.setText` returns early for the same text.

### 3.4 An action table is the single source of truth

`internal/ui/actions.go` has one list:

```go
type action struct {
    id   string
    keys []string // defaults; the keymap replaces them
    name string   // footer label
    help string   // help overlay description
    hidden bool
    run  func()
}
```

The footer, the command palette and the help overlay are all built from it. `keysFor(id)` applies the person's keymap; `keyHint(id)` gives the first key for a menu row. Posting 2's IDs are kept so old configurations keep working.

**Carto takes this.** One `ACTIONS` table gives every key: its ids, its default keys, its label for the footer, its line for the help overlay, its availability test, and its command. The footer, the `?` reference and the `a` reference read this table. No key text is written twice.

### 3.5 Hints respect availability, and overflow is dropped

Terma's `KeybindBar` shows the bindings of the focused widget and its ancestors, deduplicates by key with the focused widget winning, and hides bindings marked `Hidden`. The focused widget declares `Keybinds()`, so a hint exists only while the widget can act. Posting's footer also swaps the whole bar for one line while jump mode is active, because the keys of jump mode are different.

**Carto takes this.** `u removes at collapse` must not appear when no pin is selected. The footer shows the hints that work now. When the hints do not fit, the last ones are left out; the `?` reference always has all of them.

### 3.6 A theme is a named vocabulary, not a colour list

`internal/ui/style.go` maps meaning to colour: `methodColor`, `statusColors`. Terma's `ThemeData` names `Primary`, `Secondary`, `Accent`, `Surface`, `Surface2`, `Surface3`, `Text`, `TextMuted`, `TextDisabled`, `Border`, `FocusRing`, `Error`, `Warning`, `Success`, `Info`, and text and background variants of each (`PrimaryText`, `ErrorBg`, …). Carto's upstream `src/screen/tokens.mjs` already has the same idea.

**Carto takes this.** `src/ui/tokens.ts` names the styles: `ink`, `muted`, `faint`, `accent`, `person`, `agent`, `reasoning`, `tool`, `warning`, `danger`, `success`, `rule`, `barFilled`, `barChanging`, `barFree`, `barEstimate`, `barCap`. The screen never contains a raw ANSI code. A plain terminal without colour still reads the screen, because every distinction also has a glyph.

### 3.7 A section does three jobs

Posting's `section` widget is a titled panel with no border:

- The title is right-aligned and muted; it **brightens while focus is inside the panel**. The person knows where the keys act without an extra row.
- The heading row holds the panel's tab strip and optional info. When space runs out, the title gives way first, then info from the start, so the tabs and the last info survive.
- The body is drawn straight on the background. There is one rule per screen, under the header.

**Carto takes this.** One rule under the header. Section titles in the body are muted and brighten for the active tab. Narrow widths drop text in a fixed order.

### 3.8 Overlays are registered in one place

`internal/ui/overlays.go` builds every floating layer in one widget: palette, help, save, confirm, variables, toasts. One `a.overlay` key says which is open; `closeOverlay()` clears it; `Esc` closes. Each overlay is a `visible` flag, so the tree stays stable.

**Carto takes this.** `?`, `a`, and the Chat edit detail are overlays with one `detail` value, as today. We add one toast line for errors, in the footer's right side, because the screen must not lose a failure silently.

### 3.9 Snapshots are the UI test

Posting renders every screen state to an SVG golden file (`TestSnapshot…`, `AssertSnapshot`, `snapshot_test.go`). Terma has the same for widgets. A layout change is reviewed as an image, not argued about.

**Carto takes this.** `test/ui.test.mjs` gets a snapshot suite over ANSI-stripped text: the three tabs, idle, reading, writing, paused, and a narrow terminal. The files are small and readable.

### 3.10 What we do not take

| Posting element | Its job | Carto |
|---|---|---|
| 37 themes, user theme files | Personal ownership | No. One accent; the terminal palette decides. |
| Split panes and drag-resize | Power layout | No split view exists, so no divider. |
| Jump mode | Fast focus in a deep layout | No. Three tabs and `j`/`k` cover it. |
| Tabs overflow marks `‹ ›` | Many tabs | No. Three tabs. |
| Logo glow, wireframe art | Brand warmth | No. |
| Mouse editing | Pointer workflows | Pi TUI already gives selection and wheel scroll. |

The reasoning is not "it is decoration". Each of these either has no job in Carto, or the job is already done by something cheaper.

---

## 4. How the screen gets its frames

### 4.1 The defect

`src/runtime/ui.ts` has one timer:

```ts
setInterval(() => {
  if (busy || refreshing || quitting) return;
  ...
}, 500)
```

Pi TUI renders only when a listener calls `tui.requestRender()` (input, resize, explicit request). So while `busy` is true — that is, during every local action — no frame is requested. The spinner is not decoration: without a timer that requests frames, streaming text arrives in storage and is never drawn.

### 4.2 The three inputs to a frame

Pi Durable already gives us the events:

- `Harness.watchDoc(token, conversationId, context)` for `LiveDoc` and `InboxDoc` (`DocumentWatch<T> = WatchHandle<Readonly<T>>`).
- `Session.observeCommits(observer)` with `advance(publication)` running one microtask after each stored commit. It must be quick and must not call the Session.
- `Harness.observeTaskGraph(observer, context)` for wakes.

Carto's rule for all three: **the callback sets a flag. It does not render.**

### 4.3 The frame clock

One timer at 100 ms:

```text
tick:
  if quitting: return
  active = turn is running or cancelling, or prefill is reading
  if active and the spinner frame changed: dirty = true
  if not dirty: return
  dirty = false
  paint()
```

`paint()` builds the rows for the current width, compares each row with its last value, sets the changed ones, and calls `tui.requestRender()` only if a row changed. The spinner advances one frame per 100 ms; Pi TUI's own minimum interval is 16 ms, so this is cheap.

A second timer at 5 s refreshes file evidence (`refreshEvidence`). It never runs while a turn is active, and it never runs inside `paint()`.

### 4.4 Reading is read-only

`CartoProject.view()` loses its `syncHandles()` call. Handles are assigned at open, at restart, by `refreshEvidence()`, and by every `decide()` call that changes the Brain. A view is then: read the Brain, project context, read the live view. No commit.

While a turn is active, a frame reads only the live documents; the full transcript read happens when a commit arrives. This keeps a 10 Hz frame cheap on a long transcript.

### 4.5 What changes in the screen state

```text
ScreenState = {
  view: ProjectView          // last full read
  live: LiveSessionView      // last live read (activity, queued, busy)
  prefill: PrefillState | undefined
  tab, mode, detail, selection, folds, expanded
  sendMode, notice, spinnerFrame, width
}
```

`renderScreen(state)` is pure. That is the part the snapshot tests call.

---

## 5. The token bar

### 5.1 One bar, three segments

```text
ctx ▰▰▰▰▰▰▰▰▰▰▨▨▱▱▱▱▱▱▱▱  9.4k + 1.2k new / 32.8k · cap 16k · 32%
    └ filled ┘└change┘└ free ┘
```

| Part | Glyph | Meaning |
|---|---|---|
| filled | `▰` | Tokens the server keeps and has read |
| changing | `▨` | Tokens the server must read now, not yet read |
| free | `▱` | Room left in the window |
| cap | `┊` | The 16 000 budget, drawn in the first free cell at that boundary |
| estimate | `▤` | A number we estimated, not measured |

### 5.2 The measurement

`src/runtime/prefill.ts` wraps the `Models` object that `LiveSession` gives the Harness. For llama-swap requests it adds `return_progress: true` to the payload, and it reads the reply's SSE stream a second time with `body.tee()`. Each `prompt_progress` frame gives `{total, cache, processed, time_ms}`.

```text
fresh = total - cache        tokens the server must read
done  = processed - cache    tokens it has read
```

The bar's changing segment is `fresh - done`; the filled segment grows by what was read. When the provider sends no progress, the monitor stops at `writing`, and the bar shows the estimate. It never invents numbers.

### 5.3 The pure function

```ts
export function contextMeter(input: {
  window: number;
  cap: number;
  reading?: { total: number; cache: number; processed: number };
  settled?: number;
  estimate: number;
}): ContextMeter;
```

| Case | filled | changing | source |
|---|---|---|---|
| a reading is active | `processed` | `total - processed` | `server` |
| a reading finished | `total` | 0 | `server` |
| no reading yet | 0 | `estimate` | `estimate` |

Both parts are clamped to the window. `overCap` and `overWindow` are computed, not drawn by the view.

### 5.4 Before the first request

```text
ctx ▤▤▤▤▤▤▤▤▱▱▱▱▱▱▱▱▱▱▱▱  ~3.2k / 32.8k · cap 16k · 10% (estimate)
```

Three independent marks: the glyph, the style (muted, not accent), and the word. A terminal without colour still sees the difference.

### 5.5 Cell counts

| Width | Cells |
|---|---|
| 96 and more | 20 |
| 60 to 95 | 10 |
| below 60 | numbers only, no bar |

---

## 6. The frame

```text
  Carto · cartographer                                                llama-swap/Flint
  ────────────────────────────────────────────────────────────────────────────────────
  1 Chat   2 Brain   3 Context                                    ⠹ reading 74% · 12s
  ctx ▰▰▰▰▰▰▰▰▰▰▨▨▱▱▱▱▱▱▱▱  9.4k + 1.2k new / 32.8k · cap 16k · 32%
  ────────────────────────────────────────────────────────────────────────────────────
                                   … body …

  ────────────────────────────────────────────────────────────────────────────────────
  j k move · i input · f fold · o open · a actions · ? help        navigate · follow-up
```

| Row | Content | Job |
|---|---|---|
| 1 | Product, project, model | Where you are and what answers |
| 2 | One rule | Separates chrome from content |
| 3 | Tabs and state | What you see, and what the agent does |
| 4 | The bar | Token pressure, always |
| 5 | Body | Scrolls; the only row that moves |
| last | Footer | Keys that work now, and the last notice |

Chrome rows are padded by two cells and fill the width. Below 96 columns the bar moves to its own row; below 60 the tab labels shorten to `Chat Brain Context`.

### 6.1 State text

| State | Text | Spinner |
|---|---|---|
| Idle | `○ idle · 14:32` | no |
| Waiting for the model | `⠋ waiting for the model` | yes |
| Reading prompt | `⠹ reading 74% · 1.4k tok/s` | yes |
| Writing answer | `⠸ writing · 12s` | yes |
| Tool runs | `⠼ tool inspect src/retry.ts · 3s` | yes |
| Paused | `⏸ paused · r edits the draft` | no |
| Waiting for the person | `? waiting for your answer since 14:03` | no |
| Recently read | `· read 4.2k new in 6.1 s` | no, 20 s |
| Failed | `! model error: …` | no, danger |

### 6.2 Footer

The footer takes the whole row. Hints sit at the left after two cells of padding; the right side holds the last notice (or the insert mode state), and is dropped first when space is short.

| Mode | Hints |
|---|---|
| Navigate | `j k move · g G ends · i input · a actions · ? help` |
| Chat, item selected | `… · f fold · e edit · o open` |
| Chat, pinned item | `… · d delete at collapse · D delete now` |
| Context, pin selected | `… · u remove at collapse · U remove now` |
| Insert | `esc back · enter send` |
| Busy | `… · p pause · x cancel` |

---

## 7. The body

### 7.1 Two-row items, one meaning per mark

```text
▌C1  Person · 09:41                                        edited 09:44
  Refactor the retry layer. Keep the public API stable.
```

| Mark | Job |
|---|---|
| `▌` | The selection. One selection cue in every tab. |
| `C1` | The name the person types. Always first. |
| `Person` / `Agent` | Who speaks; a different style, not a different colour only. |
| `09:41` | Local time. The ISO stamp stays in agent context. |
| `edited 09:44` | A change, muted, at the right edge. |

### 7.2 Section heads

```text
  DURABLE CHAT                                                          2
  LIVE                                       streaming · 5 rows · o
```

Uppercase, muted, one cell of inset, a count at the right edge. The head of the section with the selection is bright.

### 7.3 One row per record in Context

The Context tab currently prints a block line and then the text again. The card's handle is the identity; the second line goes. Each row becomes:

```text
  R1  RULES · Carto protocol                              4 rules · 118 tok
  L1  LEDGER · goal · open · 09:41               Unify retry policy behind…
  C1  CHAT · Person · 09:41                      Refactor the retry layer…
  P1  PIN · selected live context · fresh        Keep the retry contract…
```

### 7.4 Empty states

A centered pair of lines: what is absent, and the key that adds it. The person learns that the screen is alive and empty on purpose.

### 7.5 Disclosure counts

`+12 rows · o` replaces `newest five rows · o expands` and `one-line completed summary · o expands`.

---

## 8. Work order and rollback points

Each step is a commit on `arena/c8108dc4-cartographer`. A commit is a rollback point.

| Step | Work | Files | Tests |
|---|---|---|---|
| **0** | This document | `docs/ui-plan.md` | — |
| **1** | The meter and the bar renderer | `src/domain/meter.ts`, `src/ui/text.ts`, `src/ui/tokens.ts` | `test/ui.test.mjs` |
| **2** | Prefill monitor and the Models wrapper | `src/runtime/prefill.ts`, `live-session.ts` | SSE server test |
| **3** | Read-only view; live-only frame reads | `src/runtime/project.ts`, `live-session.ts` | project tests |
| **4** | Frame clock, watches, spinner, new chrome | `src/runtime/ui.ts`, `src/ui/*` | frame snapshot |
| **5** | Action and hint table | `src/ui/actions.ts` | hint filter test |
| **6** | Body shape: items, heads, context rows, empty states | `src/ui/body.ts` | snapshot |
| **7** | `MINI.md` screen section | `MINI.md` | — |

If a step is wrong, `git revert` it; the next step does not depend on its internals, only on the interfaces named above.

### 8.1 What each step landed as

| Step | Commit | Notes |
|---|---|---|
| 0 | `259dfe0` | This document |
| 1–3 | `73b322a` | The meter, the prefill monitor, and the read-only view |
| 4–6 | `581468b` | `renderFrame` is one pure function; one clock drives it |
| 4–6 | `42e0823` | Every row is exactly `columns` wide, and `test/frame.test.mjs` holds it |
| 7 | `7d4f2fc` | The frame, bar, status row, and footer, in the spec |

Two defects found by the probe are worth remembering, because both look like something else:

- A full-width row padded with plain spaces wraps to two lines inside Pi TUI's `Text`, because `wrapTextWithAnsi` breaks a long run of spaces. The frame then looks three rows too tall and the footer leaves the bottom row. A style reset pair around the fill keeps the row on one line; `split` and `splitStyled` in `src/ui/text.ts` do that.
- `new Text()` pads one row above and below and one column each side. The chrome, the body, and the footer need `new Text("", 0, 0)`, or the footer is not on the last row.

### 8.2 The clock at step 4

One pending timer, not a fixed interval:

```text
wake():            dirty = true; if (not ticking) schedule 0 ms
tick():            ticking = true
                   if moving and dirty: await refresh()   // a full read
                   if dirty or spinner is due: paint()
                   schedule 100 ms while active, 1000 ms when idle
```

`wake()` is what a watch, a key, and a width check call. It never paints from a callback, so a render cannot run inside a writer. `checkWidth` runs on its own 250 ms interval: Pi TUI tells the layout about a resize, not this frame.

## 9. Tests

1. `contextMeter` with a reading, a settled reading, an estimate, over cap, and over window.
2. `meterCells` never sums above the cell count; the cap mark lands in a free cell.
3. `short()` for 0, 950, 9 400, 32 768, 123 456.
4. A llama-swap request carries `return_progress: true` and no `Authorization` header.
5. A `prompt_progress` frame moves the changing segment into the filled segment.
6. A provider without progress leaves `source: "estimate"`.
7. `view()` does not write to the Brain (commit count is stable across reads).
8. The footer hides `u`/`U` when no pin is selected.
9. Frame snapshots: three tabs, idle, reading, writing, paused, 60 columns.

## 10. Not in this plan

- Themes, split panes, jump mode, tab overflow, drag-resize.
- A command palette. The `a` reference and the editor cover it.
- Mouse editing. Pi TUI selection and wheel scroll stay.
- A second provider layer. The wrapper only adds two request options.
