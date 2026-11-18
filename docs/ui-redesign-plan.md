# UI Redesign Architecture and Design-System Plan

**Status:** Phase 6 polish and verification complete — the six-tab Screen, settled application projections, typed capability actions, and terminal compatibility paths are reconciled.

**Date:** 2026-11-16

**Scope:** A production-grade, incremental redesign of Cartographer's full-screen terminal UI and its application-facing backend boundary.

## Purpose

Cartographer already has a substantial `pi-tui` interface, durable local state, a plain-terminal command surface, and a durable coding-agent backend. Its main redesign problem is architectural rather than decorative: the full-screen UI, terminal command renderer, and domain modules currently overlap in responsibility.

This plan establishes a shared application boundary, a centralized design system, predictable navigation, non-blocking UI behavior, and complete capability exposure without weakening native grammar enforcement, consultation isolation, sandbox/approval policy, offline behavior, or the aggregate test watchdog.

## Non-negotiable constraints

- Cartographer starts visibly **disconnected**. It executes no agent work until connection and native-GBNF validation have positively reached `ready`.
- Native decisions remain native llama.cpp grammar-enforced decisions. There is no prompt-only, ordinary function-call, custom-tool, `toolChoice: "auto"`, generic-server, or otherwise degraded fallback. Missing, malformed, ignored, ineligible, or transport-failed grammar enforcement fails closed.
- Consultation material remains exclusively in **Chat → Consult**, typed and attributed. It must not appear in Conversation, Work, compaction/context injection, shared brain, or legacy Work audit rendering.
- A consultation conclusion requires evidence of a real debate and may be finalized only by authorized Cartographer behavior. The UI must not offer an arbitrary or immediate participant `consult_return` bypass.
- Context reporting uses the full backend-reported context unless `contextWindow` explicitly caps it. The UI does not subtract static reply room.
- Offline, sandbox, Bubblewrap, approval, and policy boundaries are enforced by the domain/backend; UI visibility never bypasses them.
- The aggregate `npm test` 10-second watchdog and its coverage remain intact. It may not be enlarged, disabled, or bypassed.
- This is an incremental migration. Existing behavior is preserved through facades and adapters until parity is demonstrated; no wholesale rewrite or mass file move is planned.

---

## 1. Target architecture

```text
Domain and infrastructure
        ↓
Application services, projections, actions, contracts, and events
        ↓
Shared capability and command registry
        ↓
Full-screen TUI adapter and plain-terminal adapter
```

### Boundary rules

1. Screen feature renderers do not import domain mutation modules or invoke live domain managers. Durable row, request, review, talk, shell, wake, and model actions cross `application.execute`.
2. The full-screen interface and plain-terminal interface share the semantic query/action API where an application action exists. Terminal-owned lifecycle and session-input controls remain with the terminal core.
3. Rendering consumes settled typed projections, never parses formatted output such as `/context` text.
4. Potentially slow filesystem, Git, process, transport, editor, and clipboard work stays outside rendering and key dispatch. The Screen retains narrow asynchronous infrastructure handoffs for `$EDITOR`, scratch files, and explicit copy/export.
5. The application boundary provides safe projections and controlled operations; it does not relax domain policies or expose raw unsafe internals.
6. The source remains JavaScript ESM. JSDoc contracts provide type discipline without combining this redesign with a TypeScript conversion.

### Proposed source layout

```text
src/
  cli.mjs

  composition/
    create-runtime.mjs          # Wires actual domain and infrastructure dependencies
    create-application.mjs      # Builds the shared application facade

  application/
    contracts.mjs               # JSDoc DTO, result, error, event, and job types
    result.mjs                  # Normalized result/error construction
    capabilities.mjs            # Canonical action/capability registry
    events.mjs                  # Invalidation and application event stream
    jobs.mjs                    # Long-running operation lifecycle

    queries/
      connection.mjs
      chat.mjs
      workspace.mjs
      review.mjs
      runtime.mjs
      settings.mjs

    actions/
      agent.mjs
      workspace.mjs
      context.mjs
      review.mjs
      shell.mjs
      wakes.mjs
      model.mjs
      settings.mjs
      consult.mjs

    adapters/
      terminal.mjs              # Plain-terminal adapter over application services

  infrastructure/
    filesystem.mjs              # Promise-based file/tree access
    git.mjs                     # Promise-based Git work
    process.mjs                 # Non-blocking child-process work
    editor.mjs
    clipboard.mjs
    transport.mjs

  screen/
    app.mjs                     # Thin screen composition and input controller

    design/
      tokens.mjs                # Semantic palette, spacing, border, emphasis tokens
      theme.mjs                 # pi-tui mapping and color-mode fallbacks
      layout.mjs                # Responsive rules

    shell/
      shell.mjs
      routes.mjs
      navigation.mjs
      keymap.mjs
      command-palette.mjs
      footer.mjs
      status.mjs

    state/
      store.mjs
      queries.mjs
      actions.mjs
      focus.mjs
      overlays.mjs
      notifications.mjs

    components/
      page-frame.mjs
      collection.mjs
      table.mjs
      tree.mjs
      detail-pane.mjs
      field.mjs
      form.mjs
      dialog.mjs
      confirm-dialog.mjs
      async-boundary.mjs
      empty-state.mjs
      error-state.mjs
      loading-state.mjs
      notice-stack.mjs
      key-hints.mjs

    screens/
      chat.mjs
      workspace.mjs
      review.mjs
      runtime.mjs
      settings.mjs

  terminal/
    parser.mjs                  # Transitional slash-command parsing
    renderer.mjs                # Plain text presentation only
```

Existing flat domain modules remain in place initially. They are treated as domain sources behind the new application facade, then relocated only when callers have migrated. This prevents mechanical churn from concealing safety or durable-state regressions.

### Current-to-target migration roles

| Current area | Target responsibility |
| --- | --- |
| `src/screen/app.mjs` | Thin composition, route, focus, overlay, and input coordination |
| `src/screen/{chat,workspace,review,runtime,settings}.mjs` | Focused consumption-only feature renderers over settled application projections |
| `src/screen/views.mjs` | The narrow `$EDITOR` command helper; scratch/editor handoff remains in Screen composition |
| `src/screen/theme.mjs`, `parts.mjs`, `list.mjs` | Transitional basis for centralized design tokens and components |
| `src/terminal.mjs` | Plain-terminal adapter over shared application capabilities, plus the established session/lifecycle controls |
| `src/ops.mjs` | Basis for application action services |
| Synchronous filesystem/Git/editor/clipboard work | Promise-based infrastructure adapters |

---

## 2. Shared application interface and state model

### Application facade

Both interface styles consume a single application object:

```js
application.queries.atlas(...)
application.queries.runtime.models(...)
application.execute("workspace.archive", input, options)
application.events.subscribe(listener)
application.capabilities.list(context)
```

Feature rendering does not call `ledger`, `plan`, `context`, `engine`, `windows`, or other domain managers directly. Screen composition supplies session ports to `createApplication`, while the Screen's terminal-reader/key handoff and its explicit asynchronous editor, scratch-file, and copy/export adapters remain intentionally narrow.

### Standard result contract

```js
/**
 * @typedef {(
 *   { ok: true, data: T, meta: UiMeta, notices?: UiNotice[] } |
 *   { ok: false, error: UiError, meta: UiMeta }
 * )} UiResult<T>
 */
```

`UiMeta` carries request ID, time, revision, stale/cache state, pagination, and job information as applicable.

`UiError` has stable fields:

| Field | Meaning |
| --- | --- |
| `code` | Machine-readable stable identifier |
| `message` | Safe user-facing explanation |
| `detail` | Optional diagnostic detail |
| `kind` | `validation`, `conflict`, `unavailable`, `policy`, `transport`, `native-grammar`, `cancelled`, `timeout`, or `internal` |
| `field` | Optional invalid form field |
| `retryable` | Whether a retry is meaningful |
| `suggestedAction` | Optional next capability, such as `connection.retry` |

An empty collection is successful data with zero items, not an error. Cancellation is represented explicitly and does not produce an alarming failure notice.

### State ownership

| State | Owner |
| --- | --- |
| Durable records, policy, authorization, and business rules | Domain/backend |
| Query projections, cache/stale state, and in-flight requests | Screen query store |
| Route, focused control, selection, overlays, and viewport | Screen UI store |
| Long-running operation lifecycle | Application jobs/events layer |
| Notices and status history | Screen notification store |
| Capability availability and disabled reason | Application capability registry |

### Capability registry

Each implemented capability is registered once with:

```text
id, label, category, intent, availability/disabled reason, confirmation policy
```

`createApplication` owns the registered action dispatcher and projection-invalidation scope. Target selection, form fields, page destinations, keyboard bindings, and terminal aliases remain at their narrow interface seams because they need current row/input or terminal-lifecycle state; they are not duplicated capability definitions.

The command palette receives `application.capabilities.list()` plus its six navigation destinations, so every registered action remains discoverable with its availability reason. It navigates to the narrowest existing Screen seam rather than guessing an action target. Route-local footer hints name capability IDs and hide unavailable actions from the same presentation snapshot. The terminal invokes `application.execute` for the durable Workspace, Context, Request, Review, and Runtime paths; its lifecycle controls remain terminal-owned.

### Implemented registry and interface paths

| Capability group | Registered IDs | Focused Screen / terminal path |
| --- | --- | --- |
| Kept context | `context.pin-top`, `context.clear-kept` | Model → Current accounting directs to the context seam; `/pin` and `/new` retain the terminal lifecycle path |
| Requests | `request.approve`, `request.deny`, `request.answer` | Carto → Requests and `/approve`, `/deny`, `/answer` |
| Review | `review.undo`, `review.record-windows` | Diff's confirmed `u` recovery and `/undo`; recording active shell changes is the shared recovery prelude |
| Runtime | `runtime.shell.*`, `runtime.wake.remove`, `runtime.task.message`, `runtime.model.*` | Shells, Model → Routes, task steering, and `/send`, `/kill`, `/wakes remove`, `/model` |
| Kept talk | `talk.revise-source`, `talk.forget-source` | Chat → Conversation's editor and confirmed `d`; sent requests and the Durable transcript remain unchanged |
| Workspace | `workspace.archive`, `unarchive`, `delete`, `fold`, `recall`, `toggle-fold`, `settle`, `focus-atlas`, `unfocus-atlas`, `shelve`, `unshelve`, `add`, `add-move`, `edit` | Carto row controls/forms and their terminal commands |

The wildcarded Runtime IDs are `runtime.shell.send`, `runtime.shell.close`, `runtime.shell.close-all`, `runtime.wake.remove`, `runtime.task.message`, `runtime.model.ensure`, and `runtime.model.select`; the Workspace IDs in the table retain their `workspace.` prefix.

---

## 3. Information architecture

The persistent shell includes runtime status, primary navigation, tab/subview headers, main content, a status/notice strip, and a route-local contextual footer filtered by settled capability availability.

| Screen tab | Subviews and responsibilities |
| --- | --- |
| **1 Chat** | Conversation, Work, Consult, composer, and live agent activity |
| **2 Carto** | Atlas, Ledger, Plan, Requests, Tree, and Current shared brain |
| **3 Diff** | Last step, This session, Git HEAD, checkpoints, undo/recovery |
| **4 Shells** | Shell list, selected output, and Wakes |
| **5 Model** | Routes, Latest sent, Main sent, Raw payload, Next preview, and Current accounting |
| **6 Settings** | Safety and Assessment: configuration, session policy, provider diagnostics, durable assessment, and top-copy freshness |

### Placement decisions

- Consultation remains only under **Chat → Consult** and uses an isolated `ConsultProjection`.
- Conversation and Work projections cannot contain consultation records or rendering data.
- Model history, unsent preview, and context accounting are distinct named views rather than one overloaded Model surface.
- Current accounting belongs in **Model**; collapse, pin, and fresh-context lifecycle commands remain terminal-owned and are discoverable through the palette's Context destination.
- Checkpoints and undo are available in **Diff** as well as `/undo`.
- Every registered capability is discoverable in the global command palette. A palette item routes to its narrowest existing Screen seam; actions that need terminal-only lifecycle input retain their documented terminal command. Disabled items stay visible with their reason.

---

## 4. Global design system

### Semantic tokens

Feature screens use semantic tokens only; no feature owns arbitrary ANSI colors or bespoke interaction styling.

| Token family | Examples |
| --- | --- |
| Surfaces | `canvas`, `surface`, `raised`, `overlay` |
| Text | `text.primary`, `text.secondary`, `text.muted`, `text.inverse` |
| Borders | `border.subtle`, `border.strong`, `border.focus` |
| Interaction | `focus`, `selected`, `disabled`, `loading`, `stale` |
| Feedback | `success`, `warning`, `danger`, `info` |
| Domain | `diff.added`, `diff.removed`, `diff.changed`, `activity.agent`, `activity.shell` |
| Layout | `space.1` through `space.4`, `gutter`, `pageInset`, `compactInset` |
| Emphasis | normal, dim, bold, inverse, underline |

The centralized theme maps these tokens to truecolor, 256-color, and no-color environments. In no-color mode, focus, severity, selection, and hierarchy remain discernible through borders, labels, icons/text, and emphasis.

### Shared components

| Component | Standard behavior |
| --- | --- |
| `PageFrame` | Header, breadcrumb, actions, content, and async state |
| `Collection`, `Table`, `Tree` | Focus, selection, scrolling, empty/loading/error behavior |
| `DetailPane` | Consistent read-only inspection with responsive collapse |
| `Field`, `Form` | Labels, validation, help, required/disabled/pending states |
| `Dialog`, `ConfirmDialog` | Keyboard-safe modal focus and standardized confirmation content |
| `AsyncBoundary` | Loading, stale, empty, retryable failure, and cancellation handling |
| `NoticeStack` | Success/warning/error notices and durable status history |
| `CommandPalette` | Searchable capability registry with disabled reasons |
| `KeyHints` | Footer hints derived from active capabilities |
| `StatusBar` | Connection, active job, pending work, and diagnostic summary |

### Responsive behavior

- **Expanded:** navigation, content, and optional inspector may appear together.
- **Compact:** one main pane plus a togglable inspector; labels shorten but remain meaningful.
- **Narrow or short:** single-column content, full-window dialogs, wrapped footer, and palette access to every action.
- Tables preserve identity and status first; secondary data moves into inspect detail rather than silently disappearing.
- Resize and refresh preserve focus where the referenced item still exists.

---

## 5. Navigation and keybinding map

Global semantics are fixed. A page may disable an action, but it cannot redefine an advertised key to mean something unrelated.

| Scope | Key | Meaning |
| --- | --- | --- |
| Shell | `1`–`6` | Jump to Chat, Carto, Diff, Shells, Model, or Settings |
| Shell | `Tab` / `Shift+Tab` | Next/previous tab; typing-mode Tab completes once the composer has text |
| Views | `[` / `]`, `H` / `L` | Previous/next subview within the current tab |
| Collections | `j` / `k`, `↑` / `↓` | Move the selected row |
| Collections | `g` / `G`, `Home` / `End` | First/last row; `PgUp` / `PgDn` and the wheel scroll |
| Collections | `Enter`, Space, `o` | Open/fold the selected row or perform the view's explicit open control |
| Trees/lists | `h` / `l`, `←` / `→` | Fold/open the selected row |
| Global | `Ctrl+K` | Open the command palette: six destinations, refresh, and every registered capability |
| Global | `?` / `F1` | Open the complete `KEYS_HELP` sheet |
| Commands | `r` | Refresh the visible deferred projection |
| Actions | `e` / `E` | Open the contextual form/editor or the `$EDITOR` source/template door |
| Actions | `d`, `u` | Request a scoped confirmation for destructive deletion/forget/removal or Diff recovery |
| Actions | `y` / `Y` | Copy the selected row / whole tab asynchronously |
| Input/forms | `Ctrl+Enter` | Save a multiline form field; Enter saves a one-line field |
| Input/forms | `Esc` | Leave typing for commands, or let the focused overlay/form/search handle its own close/cancel behavior |
| Safety | `Ctrl+X` | Stop active agent work through the terminal core |
| Stream | `Ctrl+V` | Pause/resume the active stream; a line or command ends a held stream |
| Exit | `Ctrl+C` | Clear the typed line; with it empty, a second press soon after leaves like `/quit` |

Additional rules:

- Printable keys belong to the focused text editor or composer; global navigation does not steal typed text.
- Screen route transitions own selection reset, projection cancellation, replacement reads, and redraw. Rendering and footer composition start no live manager read.
- `d` cannot delete, forget, or remove immediately: its focused Screen path asks for the application's scoped confirmation. Named terminal commands provide their explicit acknowledgement at the same action boundary.
- Route-local footer hints are composed from the route's key map plus the settled capability availability snapshot; `Ctrl-K palette` and `? all keys` remain global.
- `Ctrl+X` is the canonical stop control. `Ctrl+C` is deliberately not a stop alias: it keeps its clear-line/quit behavior in both the full Screen and plain terminal.

---

## 6. Async, feedback, and confirmation contract

### Connection state

```text
disconnected → connecting → validating-native-grammar → ready
                                        ↘ blocked
```

- The disconnected state is visible at startup.
- No agent run, continuation, or hidden startup work occurs before the native-grammar state is ready.
- Failed connection or validation stays visible in the shell with a retry path.
- A transport response alone cannot establish readiness; valid native grammar enforcement evidence is required.

### Query behavior

- Cached data renders immediately when available and is marked stale while replacement data loads.
- Navigation-bound and superseded queries use `AbortController` cancellation.
- Long queries and process work become cancellable jobs with progress/status events.
- Late results cannot overwrite newer query state.
- Rendering, key dispatch, and timed refreshes contain no synchronous disk, Git, process, editor, or clipboard work.

### Action behavior

- Actions expose item, page, or global loading scope.
- Repeated durable/destructive actions are de-duplicated by action/target/request ID.
- Durable mutations carry expected revision metadata where possible.
- Optimistic updates are restricted to safely reversible local interactions. Deletes, archives, policy changes, and agent actions wait for backend acknowledgement.
- Every outcome produces structured status/notice data.

### Confirmation behavior

A destructive action returns a confirmation request before execution:

```text
action ID
target identity
affected scope
human-readable consequence
confirmation strength: acknowledge | typed
expected revision
expiry/cancellation state
```

The backend validates the confirmation token and expected revision at execution time. This unifies keyboard, menu, and terminal behavior and prevents stale confirmation from mutating an unexpectedly changed target.

Immediate agent stop is the intentional exception: it executes at once to preserve user control, then reports its result prominently.

---

## 7. Safety-specific application projections

### Native grammar and connectivity

`ConnectionProjection` exposes the actual connection and grammar-validation state. Agent-start capabilities are unavailable with a concrete reason until ready. The application layer cannot replace a failed grammar path with an ordinary tool or generic transport behavior.

### Consultation isolation

- `ChatProjection` models Conversation and Work only.
- `ConsultProjection` is independent, attributed, and available only to Chat → Consult.
- Parent context, compaction, shared brain, and legacy Work audit queries receive no consultation material.
- Consult conclusion actions validate debate evidence and Cartographer authorization in the backend; the screen only displays the resulting permitted state.

### Context accounting

Runtime context projections show exact reported context, explicit `contextWindow` cap when present, and source/accounting details. They do not invent a static reply reserve.

### Policy controls

Settings surfaces make policy status and permitted controls visible, but every action remains backend-authorized. Sandbox, approval, Bubblewrap, and offline rules are not UI-only checks.

---

## 8. Migration strategy

### Phase 3 — backend/application refactor — complete

1. Add result, error, capability, event, and job contracts.
2. Build read-only application query facades.
3. Move domain mutations behind application actions, beginning with Workspace and Context.
4. Replace screen-facing synchronous filesystem, Git, editor, process, and clipboard work with async infrastructure adapters.
5. Route the plain terminal through the same actions/capabilities as the screen.
6. Retain narrow transitional adapters until behavior and safety parity are proven.

### Phase 4 — shell and component foundation — complete

1. Centralize semantic tokens and color-mode fallbacks.
2. Build the persistent shell, route manager, status bar, palette, footer, notices, and modal system.
3. Establish shared focus, selection, async-boundary, form, and confirmation behavior.

**Completion record (2026-11-16).** The Screen now composes semantic tokens/theme, persistent tabs and routes, cached status/footer/notices, the command palette and overlay system; shared models own focus, selection, async boundaries, forms, and confirmations. Rendering consumes settled projections, and status/footer rendering starts no application read. Feature-specific view migration remains Phase 5 work.

### Phase 5 — view migration

Migrate capability groups in this order:

1. Chat, including strict Consult isolation.
2. Workspace: Atlas, Ledger, Plan, Requests, Tree, shared brain.
3. Review: Diff, checkpoints, recovery/undo.
4. Runtime: Context, Shells, Wakes, Model/transport.
5. Settings & Safety: configuration, assessments, policy, and grammar diagnostics.

**Chat completion record (2026-11-16).** Chat now receives activity labels, context-collapse recognition, and roster data through an application presentation adapter. Consult records enter only through the composition-owned settled projection lifecycle; line rendering starts no audit read or state transition. Conversation and Work remain free of conference material, while Consult names loading, empty, error, and cached-stale states. The existing kept-talk removal path remains confirmation-gated.

**Workspace completion record (2026-11-16).** Atlas, Ledger, Plan, Requests, Tree, and Current shared brain now render settled application projections through the Workspace presentation adapter. Query projections carry file or project-location data, while the adapter supplies target formatting; no Workspace renderer imports a domain book or builds a durable path. The shared async boundary owns first-load, failure, and cached-stale state, while feature renderers retain their successful empty states. Existing typed workspace actions and their destructive confirmation route remain unchanged.

**Review completion record (2026-11-16).** Diff now renders settled checkpoint and Git projections through the Review presentation adapter; its renderer owns no checkpoint/Git read or durable path construction. The shared async boundary owns first-load, failure, and cached-stale states while Diff retains its successful empty states. `review.undo` is a destructive, capability-gated action shared by `/undo` and Diff's `u` control: it previews the current checkpoint, asks for a scoped acknowledgement before files change, warns when a cut-off task returns the project to its earlier checkpoint, and reopens a move revision only after recovery. Diff's recovery control records active shell changes through the typed Review ingress when a window manager is available before it names a recovery.

**Runtime Shells & Wakes completion record (2026-11-16).** Shell lists, selected output, and the wake schedule now render settled Runtime projections through a Runtime presentation adapter. The screen composes that adapter and the migrated renderers own no window-manager/scheduler/domain import or read. The shared async boundary retains first-load, failure, and cached-stale handling; Shells and Wakes retain their successful empty states. Wake removal uses the existing typed `runtime.wake.remove` action and its scoped acknowledgement dialog; the same action continues to serve `/wakes remove`.

**Runtime Model-surface completion record (2026-11-16).** Latest/Main sent, Raw payload, Next preview, and Current active-context accounting now render settled Runtime projections through the same Runtime presentation adapter. Frozen provider parsing, prospective-plan text, and context-accounting vocabulary stay in that adapter; the screen renderer owns no engine/context/domain import and treats all four surfaces as read-only. The shared async boundary owns first-load, failure, and cached-stale state while each surface retains its successful empty state.

**Runtime transport and status completion record (2026-11-16).** Model Routes now consumes the deferred `runtime.models` snapshot through the Runtime presentation adapter. It distinguishes a listed route from native-GBNF readiness, retains cached route names and a typed listing issue, and sends Enter-driven connect/select controls through `runtime.model.ensure` or `runtime.model.select`; neither action needs a destructive confirmation. The persistent strip now consumes its own scheduled `runtime.status` snapshot plus cached route state, rather than live context/window/wake/model-manager callbacks. It renders first-load, cached-refresh, and typed error diagnostics without initiating a read; successful empty runtime state remains a quiet, valid strip. Runtime projections are cancelled/superseded by the shared scheduler, and route discovery is retried only on entry, explicit refresh, or a route lifecycle event rather than every screen frame.

**Settings & Safety completion record (2026-11-16).** Settings is a sixth Screen tab with Safety and Assessment subviews, key and palette navigation, and deferred projection scheduling. Safety renders the composition-owned configuration/policy snapshot through its presentation adapter; it keeps route-listing issues distinct from native llama.cpp GBNF proof and makes blocked or disconnected state visible without authorizing work. Assessment uses the existing deferred runtime comparison and retains valid empty, stale-top-copy, loading, cancellation, and error states through the shared async boundary. Neither view imports a configuration, process, sandbox, or native-grammar manager, and their descriptive state does not alter the terminal's backend-owned authorization behavior.

Each migrated view removes direct domain imports and gains loading, empty, error, stale, and confirmation states before the next group begins.

### Phase 6 — polish and verification

- Remove obsolete direct screen mutation paths only after capability parity is proven.
- Reconcile README and design documentation with the final registry/key map.
- Retire compatibility aliases only through an explicit, documented decision.
- Preserve the aggregate test watchdog unchanged.

**Phase 6 completion record (2026-11-16).** The audit found no remaining direct Screen mutation of a durable workspace, request, review, kept-talk, shell, wake, or model manager: those paths use `application.execute`. It deliberately retains composition-only session ports passed into `createApplication`, terminal `reader`/`keys` handoff, and the asynchronous `$EDITOR`, scratch-file, source lookup, and copy/export adapters. The Settings projection reads `gate`, `initiation`, and `runner` descriptively; the Screen does not mutate them. Removing those seams would not improve action parity and would bypass established terminal lifecycle safeguards.

The six tabs, `1`–`6` dispatcher, Settings footer/help text, palette destination, and README now agree. A parity case enumerates all 30 registered actions, requires each to resolve to a declared palette tab/subview, and checks the canonical navigation, stop, pause, clear-line, palette, composer, and terminal-alias wording. The full-Screen composer completes `/consult` (including its native-grammar `probe`) and `/exit`; README also lists the piped-input-only `/wait` control. The palette lists all registered capabilities with availability reasons and navigates to the narrowest current Screen seam; contextual action execution still requires the selected target and input. `/stop` and `/pause` remain supported terminal commands for line-oriented and scripted use, while Ctrl-X and Ctrl-V are their full-Screen controls. Ctrl-C is explicitly retained as clear-line/quit behavior, not a stop alias. The 10-second aggregate watchdog remains unchanged.

**Compatibility-alias decision (2026-11-16).** The internal `Box` export is retired in favor of `Form`: every production form constructor and its coverage now use `Form`, and `src/screen/parts.mjs` is not a package entry point. The visual behavior, focus capture, validation, disabled-field handling, and asynchronous-save behavior are unchanged. Semantic style aliases remain deliberately retained because migrated feature renderers still consume them; they are not removed speculatively.

Each coherent implementation slice is committed and pushed on the current branch before its verification run.

---

## 9. Verification strategy

| Area | Required proof |
| --- | --- |
| Contracts | Every `UiResult`, typed error, cancellation, empty, stale, retry, and confirmation outcome |
| Capability parity | Every registered capability has an owner, availability reason, UI/terminal path, and coverage |
| Safety | Native grammar fail-closed behavior, disconnected startup, no work before validation, consult isolation, conclusion authorization |
| Keyboard | Registry, dispatcher, footer, help, and terminal alias parity |
| End-to-end workflows | Create/edit/archive/delete, context lifecycle, shell control, model/settings, checkpoints, wakes, consult |
| Responsive behavior | Width/height matrix, focus retention, single-pane fallback, modal behavior |
| Color modes | Truecolor, 256-color, and no-color semantic contrast |
| Responsiveness | Large tree/diff and delayed filesystem/process fixtures; no blocking render/key path |
| Regression | Durable-agent, native grammar, offline, sandbox, approval, context-accounting, and watchdog guarantees |

## Implementation gate — satisfied

The architecture and design-system plan proceeded through the approved incremental path: Phase 3 established the application-facing seams, Phase 4 completed the shared Screen shell/component foundation, and Phase 5 completed feature-view migration without a wholesale rewrite.
