# The input box, and room around the frame

Two reports from a person using Carto:

1. The frame sits against the terminal edge. The menus scrape the border.
2. While typing, the person cannot see the text. There is no input box.

The second one is the real defect, and it is not cosmetic.

## 1. What is wrong

`src/runtime/ui.ts` builds the layout like this:

```ts
const editor = new Editor(tui, editorTheme());
tui.setLayoutRoot(new VStack([chrome, { component: scroll, grow: 1 }, footer], { gap: 0 }));
```

The editor exists, is given focus in Insert mode, and receives every key. It is **never added to the layout**. `Editor` is a `Component`; it draws itself only when a parent renders it. So in Insert mode:

- the footer changes to `Esc back · Enter send`, and
- nothing else changes at all.

A person types into a widget that is not on screen. That is the whole bug: the input is mounted, focused, and invisible. `i` looks like it did nothing.

The first report has a second cause. The frame fills every cell from column 1 to `columns`, and the chrome rows start at two cells of padding inside that. There is no gutter between the frame's content and the terminal's own border, so in a terminal with a visible border or a window frame the first and last columns touch it.

## 2. What the screen becomes

```text
┌ (terminal edge)
│
│    Carto · cartographer                                        llama-swap/Flint
│    ────────────────────────────────────────────────────────────────────────────
│    1 Chat   2 Brain   3 Context                              ○ idle · 14:32
│    ▤▱▱▱▱▱▱▱▱┊▱▱▱▱▱▱▱▱▱▱  ~135 / 33k · cap 16k · 0% (estimate)
│    DURABLE CHAT                                                             3
│    ▌C1  Person · 14:32
│    ▌    Explain the retry policy.
│
│  ╭ send follow-up ──────────────────────────────────────────────────────────╮
│  │ Explain the retry policy.                                                │
│  ╰──────────────────────────── Esc back · Enter send · ⌄ history ──────────╯
│
└ (terminal edge)
```

The frame gains one cell of margin at the left, the right, the top, and the bottom. The margin is the terminal's background, not a drawn border, so a terminal that already draws a border is not given a second one.

The input box takes the place of the footer while it is open. It has a frame of its own, a title on the top-left, and the mode keys on the bottom-right. When it is closed, the footer comes back, and the bottom row of the screen is the footer again. Nothing else moves.

Why a box and not one row: a prompt that wraps needs a place to wrap to. A one-row input either scrolls sideways or grows the footer into the body, and both hide text from the person. A box declares its height, so the body shrinks by exactly the height of the box, and the line the person is typing on is always the last line inside the box.

## 3. The pieces

| Piece | File | Job |
|---|---|---|
| `margin` | `src/ui/text.ts` | One place that says how many cells the frame keeps from the terminal edge |
| `frame` margin | `src/ui/frame.ts` | Every row is `columns` wide; the outer cells are blank |
| `inputBox` | `src/ui/input-box.ts` | Pure: given the editor's lines, a cursor, a mode, and a width, return the box's rows |
| `Editor` mount | `src/runtime/ui.ts` | The editor becomes a layout child, shown only in Insert mode |
| height | `src/runtime/ui.ts` | The box is allocated the height the editor says it needs, one row at a time |

### 3.1 The margin

`renderFrame` already builds every row inside a two-cell pad. The margin is the same idea one level out:

```text
columns 96
  margin 1                margin 1
  ┌──────────────────────┴──────────────────────┐
  │  <frame content, 94 cells>                   │
  └──────────────────────────────────────────────┘
```

Two cells at 96 columns is too much and zero is what we have; one cell is the smallest change that separates the content from the edge. At 40 columns and below the margin goes to zero, because the content needs the cells more than the edge does.

The body is the one part that should fill the margin. A scrollbar drawn in column 1 of the frame reads as part of the page, not as a stripe in the gutter. So the body keeps its full width and only the chrome is inset. That is also what makes the box read as chrome.

### 3.2 The input box

The box is drawn from four parts: a top edge with a title, the text lines, a bottom edge with the keys. The corners are `╭ ╮ ╰ ╯` and the edges `─` and `│`, which the terminal already uses for its own borders, so the box reads as a container and not as content.

```text
╭ send follow-up ───────────────────────────╮
│ Explain the retry policy.▏                │
│ and a second line if it wraps             │
╰───────────── Esc back · Enter send ──────╯
```

The title is what Enter does: `send follow-up`, `send steer`, `send interruption`, `edit Chat C2`, `add Agent Chat`, or `edit the paused draft`. The person does not have to remember which key opened it.

The box is redrawn on every keystroke. The cursor cell is drawn by `Editor` itself, so the box does not guess: it takes the editor's own rendered lines, one cell of frame around them, and nothing else. That keeps Pi TUI's cursor marker where `Editor` put it, so the hardware cursor lands on the character the person is about to change.

The box never shows a stale line. When the editor's rendered height changes, the layout gets the new height in the same frame; there is no two-frame jump where a line is drawn over the footer.

### 3.3 Height

`Editor` decides its own height from its text and from `maxVisibleLines` (30% of the terminal, at least 5, plus two edge rows). The layout must be told the height before it renders, and the height is only known after a render. So the runtime renders the editor once, at the current width, counts the rows, and sets the input's `basis` to that count.

That is one extra render of one widget per resize and per keystroke, and it is the same cost the layout pays anyway.

### 3.4 Keys

The box changes what `Esc` and `Enter` mean only because it is visible while they are used.

| Key | In the box |
|---|---|
| `Enter` | send, run a command, or save the edit |
| `Esc` | close the box and return to Navigate |
| `↑` `↓` | history, then the box keeps the newest line in view |

The box is not a modal. The frame behind it keeps its selection, its scroll, and its tab; the person can close the box and find everything where they left it.

## 4. Steps and checkpoints

Each step is one commit and one rollback point.

| Step | Work | Proof |
|---|---|---|
| 1 | The margin in `text.ts` and `frame.ts`; every row stays `columns` wide | `test/frame.test.mjs` widths, an extra test that the outer cells are blank |
| 2 | `src/ui/input-box.ts`, pure, with its own tests | `test/input.test.mjs` |
| 3 | Mount the editor as a layout child, sized from its own render | a PTY transcript that shows typed text |
| 4 | `MINI.md` and this document | — |

If a step is wrong, `git revert` it. Step 3 depends on step 2's function existing, but not on its internals.

### 4.1 What the steps landed as

| Step | Commit | What it took |
|---|---|---|
| 1 | same as 3 | The gutter, and the body keeping the full width |
| 2 | same as 3 | `input-box.ts` and `test/input.test.mjs` |
| 3 | same as 3 | The editor as a layout child, painted inside the keystroke |
| 4 | same as 3 | `MINI.md`'s input section, and this note |

Three things cost time here and are worth remembering:

- **A focused component is not a drawn component.** `Editor` was given focus and every keystroke for weeks of work and never appeared, because nothing rendered it. Focus and layout are separate.
- **`basis` is read from the tree entry, not from the component.** A stack allocates by the `basis` written on its entry, so `basis: "auto"` is the only honest way to size something whose height comes from its content. A captured number is a number that is wrong one keystroke later.
- **`visible` is a predicate.** A boolean captured when the tree was built hides the box forever, whatever the mode does afterwards.

### 4.2 Superseded

The frame in this document was a set of pre-joined strings painted into three
`Text` components. That is what let the header scroll away: Pi TUI sizes a
`VStack` child by its rendered height, and an empty `Text` renders no rows, so
every chrome row measured zero. The replacement is a component tree with an
explicit `basis` on every fixed row, and `MINI.md` § "Use Pi, do not duplicate
Pi" now says so. The input box described here survives that change; the frame
around it does not.

One coupling is worth naming. `Editor` with `paddingX: 0` reserves one column for the cursor, so it wraps at `width - 1`. The box must give it exactly the cells it will draw, and `inputTextCells()` is that number in one place. If the two ever disagree, the editor wraps one line and the box cuts it on another, and the tail of a long line silently disappears.

## 5. Not in this step

- No syntax highlight in the input, no slash-command autocomplete popup. `Editor` has an autocomplete API and Carto's commands are a good fit for it later, but a menu that opens over the body is a second change.
- No multi-box stack. One input, one place.
- No mouse placement beyond what `Editor` already does.
