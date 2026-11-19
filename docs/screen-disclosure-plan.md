# Screen disclosure unification plan

**Status:** proposed — implementation not started

**Date:** 2026-11-16

**Scope:** make every text-bearing expandable Screen block follow one disclosure contract: a compact folded view, a full locally retained open view, and ordinary parent-view scrolling. This plan is deliberately limited to Screen presentation and navigation. It does not change context lifecycle collapse, durable retention policy, consultation authority, or terminal ownership.

## Decision summary

Cartographer should use one **disclosure** contract for expandable text, rather than several independently capped display paths.

1. A folded disclosure shows an intentional, bounded preview and tells the user exactly what remains.
2. Opening a disclosure emits every row that the Screen already retains. The surrounding `ScrollView` owns scrolling; no disclosure creates an inner viewport.
3. A folded live disclosure shows its newest tail. A folded settled disclosure shows its beginning.
4. `Enter`, `Space`, `o`, `l`, and `h` operate on one selected disclosure. `+` and `-` recursively open or fold disclosures; they do not alter whether an individually opened disclosure may show its full retained body.
5. Durable and runner retention limits remain real limits. The UI says when a retained value was clipped instead of presenting a partial result as complete.
6. Copy continues to export the full locally retained value, independent of visual fold state.

The name *disclosure* is intentional. It distinguishes Screen-only presentation folding from a lifecycle/context collapse, which remains terminal-owned and has separate durable semantics.

## 1. Boundaries and non-goals

This work must preserve the existing Screen/application boundary:

- Feature renderers and key handlers consume settled data only. They do not start durable reads, import managers, or inspect live domain state.
- Consultation material remains exclusively in Chat → Consult. A disclosure helper receives already-projected text; it cannot fetch an audit or move material into Talk or Work.
- The terminal remains authoritative for lifecycle behavior. This plan does not add Screen execution for context clear, pin, fresh-context, or collapse operations.
- There is no arbitrary command-start control, raw manager exposure, or new terminal closure passed into Screen.
- Data retention is not expanded as a side effect of a presentation change. The plan only makes the text currently retained by the relevant Screen model reachable through ordinary scrolling.
- Trees/folders, modal sheets, terminal emulators, pickers, forms, and the composer are not automatically converted to disclosures. They have structural or viewport behavior of their own.

The plan therefore unifies **text bodies**, not every component that happens to have an open/closed state.

## 2. Current behavior and gaps

The outer viewport is capable of scrolling all rows. `ChatBody` and `ListBody` hand their rows to `ScrollView`; the discontinuities come from feature renderers deciding not to emit rows.

| Surface | Current folded/open behavior | Gap |
| --- | --- | --- |
| Main and grouped private reasoning | Folded previews are bounded; an opened completed item emits all wrapped retained rows. Live reasoning uses a newest-tail preview. | This is the intended baseline. Preserve its privacy styling, copy behavior, and completed-item reset semantics. |
| Consult event body | A selected event opens to all retained rows, but the folded path always takes the first preview rows, including live events. | A live conference event stops advancing visually after its first preview rows instead of behaving like live reasoning. |
| Work call detail | `row.detail` is locally capped at `chatDetailChars`, then an open detail renders only `chatDetailRows`. | Opening does not reach the end of the locally held detail. |
| Context/state/windows/read blocks | An open block renders only `BLOCK_ROWS`. | The remainder is reachable only by copy, not by Screen scrolling. |
| Generic list body | An individually open body renders at most `listBodyRows`; global `+` alone switches it to unlimited rendering. | “Open this row” and “open all rows” have different content semantics. This reaches Diff, Shells, Model, reports, assessment, and other list-backed views. |
| Chat navigation | `j` and `k` select disclosure headers. When a long body is in view but no other header is, Chat can reveal the old selection rather than scrolling a row. Lists already fall back to row scrolling. | Long Chat and Consult content feels less continuous than long list content. |

There is also an affordance mismatch. Some blocks say `Enter opens all`, while `+` is the actual global open command. The former should say `Enter opens this block`; “all” is reserved for the global command.

## 3. Disclosure contract

### 3.1 Eligibility

A disclosure is a text-bearing leaf that has a stable owner and can be represented as wrapped rows:

- private reasoning and private notes;
- consultation reasoning, prose, tool-call arguments, tool results, selector detail, final advisory, and status detail;
- ordinary call results and errors shown in Work;
- context/request/state/windows/read blocks shown in Chat;
- list item bodies, including patches, reports, shell tails, provider payloads, context parts, and assessment text.

A group, conference, folder, or other structural container may contain disclosures but retains its own hierarchy and default-open policy. For example, a running conference can remain visibly expanded while each long event body uses the common disclosure contract.

### 3.2 Folded and open rendering

For wrapped rows `rows` and a preview limit `n`:

| State | Static/settled content | Live content |
| --- | --- | --- |
| Folded | `rows.slice(0, n)` | `rows.slice(-n)` |
| Open | all `rows` | all `rows` as they grow |

A header is selectable whenever the body is expandable. Suggested shared language:

```text
▸ Private reasoning · 27 more lines · Enter opens this block
▸ Ledger · tool result · 12 earlier lines · Enter opens this block
▾ Request block · 32 lines · Enter folds this block
```

Short content without hidden rows may stay non-expandable, but Work/Consult can retain their existing lightweight provenance header where it is useful.

### 3.3 Controls and nesting

| Input | Meaning |
| --- | --- |
| `Enter`, `Space`, `o` | Toggle the selected disclosure or structural container. |
| `l`, `→` | Open the selected disclosure/container. |
| `h`, `←` | Fold the selected disclosure/container. |
| `+`, `zR` | Open all disclosures and containers in the active projection. |
| `-`, `zM` | Fold all disclosures and containers in the active projection. |
| `Ctrl-E`, `Ctrl-Y`, page keys, wheel, scrollbar | Scroll the one surrounding viewport. |
| `End` / `G` | Reach the end and resume normal end-follow behavior for a live Chat view. |

Opening a parent container makes its child headers available. It does not silently force every child disclosure open; `+` is the recursive command.

### 3.4 Scroll and live-follow behavior

The Screen must have exactly one scrolling owner for this content: the page-level `ScrollView` already surrounding Chat or a list-backed page.

- Explicitly opening/folding a block preserves the current viewport so a block above the cursor cannot pull the reader unexpectedly.
- A live view follows new rows only while it is following its end. Any intentional scroll into history suspends follow; `End` resumes it.
- Opening a live disclosure is an inspection action, not permission to create a nested, independently scrolling pane.
- When no next/previous selectable header exists in the requested direction, Chat should use the existing list behavior and scroll the outer view one row instead of jumping back to a header outside the viewport.

This policy makes a long conference event, a long private reasoning item, and a long patch feel like parts of one continuous terminal document.

### 3.5 Retention, clipping, and copy

“Full” means all text that is already locally retained. It never means “read more from a manager” or “ignore a durable cap.”

- Conference activity and tool receipts already carry clipping metadata. Retain and render that provenance after the visible rows.
- Work call detail currently turns a character cap into a synthetic trailing string. Normalize it to explicit retained/clipped metadata so the UI can distinguish a display preview from missing source text.
- Runner output that retains only a tail should say that earlier output was dropped when that fact is known.
- Existing canonical views or reports remain the route to material that was intentionally not retained in the Chat model.
- `y` exports the same full locally retained text before and after opening. It must not trigger a domain read.

## 4. Target architecture

Add a small pure helper under `src/screen/`, for example `disclosure.mjs`. It does not render a component, own scrolling, read data, or mutate application state.

```js
const plan = disclosureRows({
  rows,
  open,
  previewRows,
  preview: live ? "tail" : "head",
  retained: { clipped, originalChars, reason },
});
```

The helper returns only a presentation plan:

```js
{
  visibleRows,
  totalRows,
  omittedRows,
  expandable,
  mode: "folded" | "open",
  retainedNotice,
}
```

Feature renderers remain responsible for their visual identity, indentation, accessibility of headers, and line references. The helper only makes the body-selection rule consistent.

### 4.1 State ownership

Expansion state stays local to the model that owns the content:

| Owner | Stable state source |
| --- | --- |
| Standalone Chat item | The item’s existing local open state. |
| Grouped Work row | The row’s local open state, keyed by its stable local identity rather than a rendered line number. |
| Consult event | `eventOpen`, keyed by its existing event key. |
| List body/folder | The list’s existing keyed open/closed state. |

Use existing stable item, call, and event identities wherever they exist. Do not make disclosure state depend on a transient rendered row offset. The helper is deliberately not a global registry: that would couple independent Chat/List lifecycles and risk consultation-boundary mistakes.

### 4.2 List mode correction

`createList()` may retain its efficient `all`/`opened`/`closed` state representation. What changes is the coupling between that state and content availability:

- An individually open list body emits all locally retained rows.
- `+` changes which rows are open recursively; it no longer removes a separate rendering cap.
- `-` closes rows recursively and leaves no stale body rows behind.

This keeps the existing global behavior while making a single-row open semantically honest.

### 4.3 Chat and Consult correction

`createChat()` should use the helper for all long text bodies:

1. Preserve the completed/private reasoning behavior already fixed: a completed standalone item folds to a bounded head preview and opens to all retained rows.
2. Apply the same plan to grouped private notes/reasoning.
3. Use `event.live`, rather than event type alone, to choose a tail preview for live Consult activity.
4. Replace the post-open `DETAIL_ROWS` and `BLOCK_ROWS` caps with full retained-row emission.
5. Preserve the existing conference session/event hierarchy, `eventOpen` state, copy export, Consult cache ownership, and Work/Talk isolation.

The current `chatDetailChars` input-retention ceiling may remain for the first migration. It is a data-memory policy, not a display-row ceiling. It must become explicit metadata before its presentation is standardized.

## 5. Incremental delivery plan

### Slice A — Pure disclosure contract

**Files:** add `src/screen/disclosure.mjs`; add focused tests in the existing Screen test locations.

- Define folded-head, folded-tail, open, short-body, and retained-clipped outcomes.
- Keep it dependency-free except for the already-wrapped rows passed by callers.
- Add no configuration knob and no application action.

**Proof:** deterministic unit coverage for body selection, omitted counts, and retained notices.

### Slice B — Chat and Consult

**Files:** `src/screen/chat.mjs`, narrowly `src/screen/app.mjs`, Screen tests.

- Migrate private material, Consult event bodies, call details, and request blocks to the helper.
- Normalize text labels and preserve per-kind style/background/reference fields.
- Make folded live Consult bodies advance at their tail.
- Make chat navigation scroll one row when no next/previous stop is available in the viewport.
- Preserve viewport and explicit end-follow behavior through one narrow input/scroll coordination seam.

**Proof:** deterministic Chat-model tests plus an actual PTY case for a long live conference body and a long settled detail body.

### Slice C — Generic lists

**Files:** `src/screen/list.mjs`, list tests, and only feature-renderer changes required by an explicit retained/clipped marker.

- Remove the renderer-only `BODY_ROWS` post-open limit.
- Retain recursive folder/body opening and selection reconciliation.
- Verify long Diff, Shell, Model, and report-style list bodies use the ordinary page scrollbar and preserve copy behavior.

**Proof:** a large body can be opened individually, its last retained row is emitted, `+` still recursively opens, and `-` removes all body rows.

### Slice D — Regression and terminal verification

**Files:** test-only unless a demonstrated integration issue requires a narrow Screen fix.

- Run the full aggregate suite without changing the immutable 10-second watchdog.
- Verify the pushed branch under a real PTY at a narrow and normal width.
- Verify all ScrollView changes against live follow, explicit scrolling, selection movement, and resize behavior.

Each slice is one atomic commit and is pushed before broad testing. No source migration begins in a slice until the preceding slice’s boundary tests are passing.

## 6. Test matrix and acceptance criteria

### Model-level coverage

| Case | Required assertion |
| --- | --- |
| Long completed reasoning | Folded head preview is bounded; opening emits its retained tail; folding restores compact form. |
| Long live reasoning | Folded tail advances; opening emits all current rows; a new response starts folded under the existing completed-response contract. |
| Long live Consult event | Folded preview advances with the latest reasoning/prose/tool text; opening emits all retained current rows. |
| Long settled Consult event | Opening emits all retained rows; clipping metadata remains visible; copy stays isolated to Consult. |
| Long call detail | One-item open reaches the final retained row without `+`; retained character clipping remains honest. |
| Long request/context block | Open reaches the final retained row; copy remains exact. |
| Long list body | One-item open reaches final retained row; `+`/`-` retain recursive behavior. |
| Private boundaries | No Work/Talk line or copy path gains conference material; rendering initiates no audit read. |

### Navigation and PTY coverage

- Scroll a long open Chat/Consult body with row, page, wheel, and End controls.
- Press `j`/`k` while a long body is in view with no other selectable header; the viewport moves one row rather than warping to an off-screen header.
- Open a block above the viewport and verify the visible text does not jump.
- Follow a live stream at the end; scroll into history; verify new rows no longer pull the viewport; press End and verify normal end-follow resumes.
- Resize while a long body is open and verify lines rewrap, omitted counts remain correct after folding, and the selected block remains valid.
- Preserve the full suite’s fixed 10,000 ms aggregate watchdog.

## 7. Risks and decisions deliberately deferred

| Risk | Mitigation |
| --- | --- |
| A very large opened payload can create many rendered rows. | This is already possible through global `+`. The user must explicitly open the specific body; retain upstream data caps and existing row caches. |
| “Full” could be mistaken for a source read. | State “retained” in clipping notices; never add a reader to a render/key path. |
| Parent and child open state can become confused. | Keep state at current model owners and use stable keys; `+` is the only recursive control. |
| Auto-follow can make reading unstable. | Follow only at the end; explicit inspection preserves viewport; End is the explicit resume control. |
| Unifying all open/closed structures would overreach. | Limit this plan to text disclosures; preserve folder/tree, modal, and terminal-emulator behavior. |

The plan does not add user configuration for preview lengths, follow policy, or disclosure mode. Existing policy constants may be simplified or repurposed only after the migration proves which still represent intentional previews rather than accidental post-open caps.
