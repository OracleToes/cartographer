# UI redesign — Phase 2 architecture and design-system plan

**Status:** proposed — implementation approval required

**Date:** 2026-11-16

**Scope:** a targeted continuation of the completed six-tab Screen migration, based on [the Phase 1 gap analysis](./ui-redesign-phase-1-gap-analysis.md). This plan is architecture and design only. It does not authorize implementation.

## Decision summary

Cartographer does not need a replacement TUI or a second backend. The next design keeps the established application facade and adds four narrowly bounded capabilities:

1. **Configuration becomes a first-class projection and action surface.** All 30 settings become visible with value provenance and can be edited in an explicit persisted source, without pretending that environment variables, command-line flags, or a live safety switch are ordinary saved settings.
2. **Every user-facing capability gets a launch path, not merely a palette destination.** A shared action launcher resolves a settled target, collects validated fields, obtains a backend-owned confirmation when necessary, and calls `application.execute` exactly once.
3. **Terminal-owned lifecycle behavior gains a typed port.** The Screen can surface safe session controls without importing mutable terminal/domain managers or turning agent-only shell execution into a raw user command runner.
4. **Slow work becomes genuinely asynchronous before it is described as non-blocking.** Promise-based filesystem/process/Git ports and cancellable jobs replace the current “yield, then perform synchronous work” transition one bounded operation at a time.

No completed Screen safety work is removed. Native llama.cpp GBNF proof, consultation isolation, approval, checkpoints, Bubblewrap policy, offline startup, Ctrl-C clear-line/quit behavior, Ctrl-X stop, Ctrl-V pause/resume, and piped-input-only `/wait` remain hard constraints.

## 1. Baseline and non-goals

The current baseline already provides:

- a `pi-tui` six-tab Screen and a plain-terminal adapter;
- `application.execute`, `UiResult`, typed errors, capability availability, events, invalidation, deferred projections, shared focus/selection/overlays/forms/confirmations, and semantic theme tokens;
- 30 registered application action IDs across Context, Requests, Review, Runtime, Talk, and Workspace;
- narrow Screen composition seams for reader/key handoff, editor, scratch file, source lookup, copy/export, and terminal lifecycle;
- a fixed 10-second aggregate test watchdog.

The plan explicitly does **not**:

- rewrite the Screen, terminal parser, domain modules, or storage format wholesale;
- move files just to match a diagram;
- replace JavaScript/JSDoc with TypeScript;
- expose arbitrary shell command starts, raw domain managers, or consultation-finalization internals to the user;
- claim that `queueMicrotask` makes synchronous filesystem, Git, or domain work non-blocking;
- remove `LEGACY_STYLE_ALIASES` until every consuming renderer has proven semantic-token parity;
- persist a session-only switch merely because it is visible in Settings.

## 2. Target architecture

```text
Existing domain modules and durable stores
  ├─ .brain records, SQLite session, checkpoints, wakes, windows
  ├─ model transport and native-grammar validation
  └─ approval, sandbox, consultation, and task policy
                    │
                    ▼
Infrastructure ports
  ├─ async filesystem/config repository
  ├─ async Git/process ports
  └─ explicit terminal lifecycle port
                    │
                    ▼
Application facade
  ├─ typed queries and projections
  ├─ typed actions and confirmations
  ├─ capability/action specifications
  ├─ settings provenance and settings actions
  ├─ jobs, events, revisions, and invalidation
  └─ lifecycle actions delegated to terminal composition
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
Full Screen adapter     Plain-terminal adapter
  ├─ routes, selection    ├─ slash parsing and text rendering
  ├─ action launcher      └─ same semantic actions/results
  ├─ forms/dialogs
  └─ settled projections
```

### Boundary rules

1. **Only application/lifecycle ports mutate durable or live session state.** Screen renderers, key handlers, and form components never call `ops`, `wakes`, `windows`, `engine`, `runner`, `gate`, `initiation`, or raw configuration files.
2. **The Screen reads settled projection data only.** A route, key press, or render may schedule work, but only an asynchronous query/job owns that work; a paint never starts a domain read.
3. **The domain remains authoritative.** Input validation in a form is usability feedback, not permission. Application actions validate again, resolve policy, apply confirmation/revision checks, and return a typed result.
4. **Lifecycle remains composition-owned.** The terminal supplies a narrow typed lifecycle port; it does not give the Screen a mutable terminal closure or an unbounded manager.
5. **A safety boundary is not a discoverability failure.** Agent-only tools, piped-input behavior, process exit, and arbitrary command launch are shown with their reason rather than being exposed as unsafe UI controls.
6. **Compatibility stays until parity is proven.** Existing slash commands continue to call the same application actions while direct Screen controls are introduced.

## 3. Incremental source layout

The first implementation slice is additive. Existing callers stay on their current flat modules until a replacement has coverage; no mass move is required.

```text
src/
  config.mjs                         # Retained compatibility facade: defaults, resolution, public validation
  configuration/                     # New, focused configuration boundary
    schema.mjs                       # Shared parse/coerce/validate rules for all 30 known keys
    sources.mjs                      # Defaults/core/project/env/CLI provenance and effective snapshot
    repository.mjs                   # Async JSON read, revision, atomic write, source permissions

  application/
    app.mjs                          # Extended composition only
    contracts.mjs                    # Extends UiMeta, UiConfirmation, UiJob contracts
    capabilities.mjs                 # Retains capability registration and availability
    action-specs.mjs                 # Canonical input/target metadata for actionable capabilities
    settings.mjs                     # Settings projection reader; now includes provenance
    settings-actions.mjs             # Typed edit/reset persisted-setting actions
    lifecycle.mjs                    # Typed adapter over terminal-owned lifecycle ports
    jobs.mjs                         # Real cancellable async job lifecycle
    events.mjs                       # Existing stream; adds narrow configuration/job invalidations
    queries.mjs                      # Incremental async query migration, not a broad rewrite

  infrastructure/
    filesystem.mjs                   # Extended Promise-based reads/writes/tree traversal
    config-files.mjs                 # Atomic config persistence seam used by repository.mjs
    process.mjs                      # Extended abort-aware child process seam
    git.mjs                          # Added only when Review/Git reads migrate

  screen/
    app.mjs                          # Retained shell composition and route/input coordination
    action-launcher.mjs              # Launch state machine; no domain imports
    action-dialog.mjs                # Generic target/field form over an action specification
    action-placement.mjs             # Route, row, palette, shortcut, and terminal-path presentation map
    collection-frame.mjs             # Shared collection/action-bar/inspector behavior
    detail-pane.mjs                  # Responsive selected-item inspector
    job-drawer.mjs                   # Visible queued/running/cancelled job states
    settings-editor.mjs              # Settings collection and source/provenance inspector
    tokens.mjs, theme.mjs            # Retained semantic theme source
    parts.mjs                        # Retained until migrated consumers prove parity
    {chat,workspace,review,runtime,settings}.mjs
                                   # Retained feature renderers over settled data

  terminal.mjs                       # Retained parser/lifecycle composition
  terminal/                          # Created only after the first shared lifecycle/settings parser extraction
    settings-command.mjs             # Optional thin line-mode settings grammar
    lifecycle-command.mjs            # Maps existing slash aliases to lifecycle port actions
```

### File-migration policy

- `src/screen/app.mjs`, `src/terminal.mjs`, and feature renderers stay where they are for the first slices. New shared modules are imported into them; they are not copied or renamed first.
- `src/config.mjs` remains the public resolver during migration. `src/configuration/` factors pure schema, provenance, and persistence behind it so existing launch behavior does not change accidentally.
- The optional `src/terminal/` directory is not created merely to satisfy the diagram. It appears only when the same parser logic is actually shared and covered.
- Existing infrastructure files are extended before adding overlapping helpers. `git.mjs` is deferred until a real async Git projection is migrated.

## 4. Configuration and policy design

### 4.1 Effective settings projection

Settings becomes an inspectable, settled projection with one row for every known key:

```js
{
  key: "collapseFull",
  label: "Working-context collapse threshold",
  effectiveValue: 80,
  displayValue: "80%",
  source: {
    layer: "project",             // default | install | project | environment | command-line
    path: ".brain/config.json",  // omitted for default/environment/CLI
    writable: true,
    overriddenBy: undefined
  },
  persistence: "project",
  apply: "next-session",          // live-screen | next-request | reconnect | next-session
  risk: "normal",                 // normal | warning | guarded
  validation: { kind: "integer", min: 30, max: 95 }
}
```

The projection also carries:

- the effective configuration revision for safe writes;
- every source layer that contributed a value, without reading arbitrary unknown keys into the UI;
- the active session values for approval, initiation, sandbox, pause, and connection separately from persisted defaults;
- native-grammar and provider readiness as facts, never as a UI-authorized ready state.

A saved project/install value may be visibly shadowed by `CARTO_SERVER`, `CARTO_MODEL`, `CARTO_USER`, `--url`, or `--model`. The UI says **saved but currently overridden**, rather than silently changing a file while reporting that the live process changed.

### 4.2 Source and write rules

| Source layer | Readable | Writable from Settings | Notes |
| --- | --- | --- | --- |
| Built-in defaults | Yes | No | Baseline values only; reset removes a lower-layer override. |
| Install config | Yes | Yes, when the file is writable and explicitly selected | Affects projects using that installation. The default editor target is never install scope. |
| Project `.brain/config.json` | Yes | Yes | Default persistence target; atomic write after schema validation. |
| Environment | Yes | No | Process-owned override; Settings explains how to unset/change it outside Cartographer. |
| CLI flags | Yes | No | Invocation-owned override; Settings names the active flag and says it lasts for this run. |
| Session policy state | Yes | Through lifecycle actions only | Not a config-file write and never remembered by accident. |

Write flow:

1. The user selects a setting and opens its schema-derived editor.
2. The editor validates locally for immediate feedback, then submits `{ key, value, scope, expectedRevision }` to `settings.edit`.
3. The backend re-validates with the same schema, checks source writability and revision, writes a temporary JSON file, atomically renames it, re-resolves effective provenance, emits `configuration.changed`, and returns the new snapshot/revision.
4. The Screen invalidates only Settings and projections whose **future** behavior depends on the changed setting. It reports whether the new effective value applies live, on the next request, after reconnect, or at next launch.

There is no generic “edit arbitrary JSON” action. Unknown/retired keys stay rejected by the existing configuration contract.

### 4.3 All 30 settings have an explicit route

| Group | Settings | Default write/apply policy | Guard |
| --- | --- | --- | --- |
| Provider | `server`, `model` | Project or explicit install source; reconnect/new session | Model readiness remains native-grammar gated. A saved model is not selected until validation succeeds. |
| Identity and appearance | `user`, `screen`, `colors`, `theme`, `thinking` | Project/install; `colors` and `theme` may update the Screen after commit, the rest apply next session | No hidden terminal mutation. |
| Agent and shell limits | `contextWindow`, `maxTokens`, `mainTurns`, `taskTurns`, `shellWait`, `windowTail`, `wakeMin`, `wakesMax`, `treeDepth` | Project/install; next request or next session as declared by the owner | Shared schema keeps existing bounds, including task-turn, tree-depth, and window-tail caps. |
| Shell read scope | `shellRead` | Project/install; next session | Guarded editor with canonical path list, explicit scope review, and typed confirmation before adding a location outside the project. |
| Persistent policy defaults | `initiate`, `yolo`, `bwrap` | Project/install; next session | `yolo: true` and `bwrap: false` require typed confirmation. These writes do not alter the current session switch. |
| Stream and request behavior | `repeatCut`, `prefill`, `prefillTokens`, `askMinutes` | Project/install; next request/session according to the current owner | Existing validation remains authoritative. |
| Context behavior | `handoffQuestion`, `chatWindow`, `collapseTokens`, `collapseMinutes`, `collapseFull`, `readAhead` | Project/install; next request/session according to the current owner | Context limits are revalidated together, including the `chatWindow <= contextWindow / 2` relationship. |

`settings.reset` removes an override from the selected writable source and shows the newly effective lower-precedence value. It does not erase an environment or command-line override, and it does not turn a session policy switch off/on.

### 4.4 Settings information architecture

The existing Settings tab becomes three compact subviews while retaining the current Assessment behavior:

| Subview | Content | Primary controls |
| --- | --- | --- |
| **Configuration** | All 30 settings, effective value, source, apply timing, and selected-item inspector | `Enter`/`e` edit, `x` reset this source override, `s` choose writable source |
| **Safety** | Current approval/initiation/sandbox state, saved defaults, provider/native-grammar summary, and lifecycle restrictions | Open guarded lifecycle actions; never directly mutate a manager |
| **Assessment** | Existing durable assessment and top-of-context freshness | Existing source/editor door only where already supported |

On wide terminals Configuration shows collection and inspector together. On compact/narrow terminals the inspector becomes an opened detail view; identity, value, source, and apply timing remain visible before secondary text is hidden.

## 5. Capability, action-launch, and lifecycle design

### 5.1 Two related registries, one action owner

The current capability registry remains the source of truth for action identity, intent, confirmation policy, and availability. It gains schema metadata through a separate pure action-spec layer rather than putting Screen widgets into domain actions.

```text
Application capability definition
  id, label, category, intent, availability, confirmation, input schema, target kind

Screen action placement
  action id, route, settled target source, shortcut, palette text, form title

Terminal alias placement
  action id, existing slash grammar and acknowledgement wording
```

This separation keeps a row selection and a form layout in the presentation layer while ensuring that field names, validation, confirmation strength, and availability do not drift between Screen and terminal.

### 5.2 Action-launch state machine

```text
palette / local shortcut
        │
        ▼
resolve action placement
        │
        ├─ route has no target or input ──► execute action
        │
        └─ route needs context
                │
                ▼
       route to declared view and retain a pending launch
                │
                ▼
       resolve target from settled selection or TargetPicker
                │
                ▼
       ActionDialog validates schema-derived fields
                │
                ▼
       application.execute(action, input, { requestId, expectedRevision })
                │
          ┌─────┴─────────────────────┐
          ▼                           ▼
  typed confirmation             UiResult success/failure
          │                           │
          ▼                           ▼
 ConfirmDialog with exact      notice, scoped invalidation,
 target/token/revision         selection preservation, refresh
          │
          ▼
 application.execute(...confirmation)
```

The palette no longer says “available through the terminal command surface” for a normal user action. It either opens its direct launcher, or shows a deliberate boundary reason. A route transition does not query live state; the target picker consumes the target route's already settled projection and asks the user to refresh if it is unavailable.

### 5.3 Existing 30 actions: focused Screen completion map

| Group | Existing IDs | Planned Screen completion path |
| --- | --- | --- |
| Context | `context.pin-top`, `context.clear-kept` | Model → Current accounting action bar. Pin uses a short reason form; fresh context uses the lifecycle bridge plus the existing kept-context action sequence. |
| Requests | `request.approve`, `request.deny`, `request.answer` | Carto → Requests. `a` approves a selected move, `n` opens denial reason, and `e` opens an answer form for a selected question. |
| Review | `review.undo`, `review.record-windows` | Diff. `u` retains confirmed undo; “record shell changes” becomes a visible action/palette entry rather than an unexplained prerequisite. |
| Runtime shells | `runtime.shell.send`, `runtime.shell.close`, `runtime.shell.close-all` | Shells → List. `s` opens send-input form; `d` confirms selected close; `D` confirms close all. No raw command-start control is added. |
| Runtime wakes | `runtime.wake.remove` | Shells → Wakes retains `d` confirmation; creation/edit are added as new typed wake actions below. |
| Runtime task/model | `runtime.task.message`, `runtime.model.ensure`, `runtime.model.select` | Chat → Work gets a task-message form (`m`); Model → Routes retains Enter-driven ensure/select and gains palette-launch support. |
| Kept talk | `talk.revise-source`, `talk.forget-source` | Chat → Conversation retains `e`/`d`; launcher makes their selected-source target explicit. |
| Workspace | all 14 `workspace.*` IDs | Existing Carto forms/row controls remain the primary path; palette completion uses the same forms and settled target picker instead of composing slash text. |

The workspace IDs are unchanged: `archive`, `unarchive`, `delete`, `fold`, `recall`, `toggle-fold`, `settle`, `focus-atlas`, `unfocus-atlas`, `shelve`, `unshelve`, `add`, `add-move`, and `edit` under the `workspace.` prefix.

### 5.4 New wake CRUD actions

The wake backend already has a user-meaningful `set` capability, but only remove is currently exposed through `RUNTIME_ACTION`. The application boundary will add:

```text
runtime.wake.create
runtime.wake.replace
runtime.wake.remove
```

- **Create** accepts the existing complete time/file/window trigger schema and reuses the wake manager's validation.
- **Replace** is a complete replacement, not a loose field patch: it preserves the wake ID, validates a new complete trigger, resets its schedule/history/look state clearly, and records a replacement notice. It is unavailable if the wake disappeared after selection.
- **Remove** retains its existing acknowledgement confirmation.

The Wakes form changes fields according to trigger kind and uses settled shell-window names only as suggestions; backend validation remains authoritative. A wake can still cause a whole later agent turn, so the form says that plainly.

### 5.5 Lifecycle port and boundary classification

`application.lifecycle` is a typed adapter supplied by `runTerminal`/Screen composition. It reports `UiResult` and capability availability but delegates actual behavior to the terminal's established ownership. It never exposes the terminal's raw mutable closures.

| Classification | Operations | Screen behavior |
| --- | --- | --- |
| **Direct Screen lifecycle action** | stop, pause/resume, collapse, fresh context, session approval toggle, session initiation toggle, session sandbox toggle, consultation selector probe | Direct launcher/control through lifecycle port. Existing safety checks, active-task restrictions, close-before-switch behavior, and notices stay in the terminal owner. |
| **Application action** | The 30 current IDs plus Settings and wake actions | Standard action launcher through `application.execute`. |
| **Agent-only domain capability** | Declared-plan shell command start, model tools, internal task/work transitions, consult conclusion authorization | Inspectable where appropriate but not actionable. No UI control can manufacture an approved move or bypass authorization. |
| **Terminal/input/process boundary** | `/wait` with piped input, `/quit`/`/exit`, Ctrl-C signal handling | Palette/help may name the restriction. `/wait` stays disabled in the interactive Screen because its meaning is only valid for piped input. Ctrl-C semantics remain unchanged. |

The fresh-context action is deliberately lifecycle-owned because it resets live conversation/engine state before invoking existing `context.clear-kept` and `context.pin-top`; a Screen must not attempt to reproduce that sequence itself.

### 5.6 Confirmation and revision contract

The current confirmation shape is extended rather than replaced:

```js
{
  id,                   // opaque, short-lived confirmation token
  actionId,
  target,
  summary,
  strength,             // acknowledge | typed
  expectedRevision,
  expiresAt
}
```

Action options become:

```js
{
  requestId,            // idempotency/de-duplication key
  signal,
  expectedRevision,
  confirmation: { id, acknowledged, phrase? }
}
```

The action owner checks the token, target, action, expiry, and revision at execution time. A changed target returns a typed `conflict` result and asks the Screen to refresh rather than applying a stale confirmation. Existing named terminal commands retain their explicit acknowledgement wording, but perform the same request/confirm handshake internally.

`Ctrl-X` remains the intentional immediate exception: stopping active agent work does not wait for confirmation.

## 6. State management, async work, and backend contracts

### 6.1 State ownership

| State | Owner | Screen rule |
| --- | --- | --- |
| Durable workspace, requests, checkpoints, wakes, configuration files | Domain/backend and configuration repository | No direct Screen mutation. |
| Live session/lifecycle state | Terminal-owned lifecycle port | Screen reads projection/status and dispatches typed lifecycle actions only. |
| Effective configuration and provenance | Application Settings query | Screen stores settled snapshot and revision only. |
| Query cache, stale/loading/error/cancellation | Existing projection scheduler, extended with job linkage | No render-time reads; late settlement cannot replace newer data. |
| Route, focused region, selected ID, pending launcher, overlays | Screen state | Preserve identity across refresh/resize; clear a pending launch only when its target disappears. |
| Notices/status history | Screen notices/status components | Render result/job events; do not infer outcome from formatted terminal text. |
| Capability availability | Application registry plus settled session context | Disabled reason is visible in footer/palette/dialog. |

A broad Redux-like store is unnecessary. The existing focused ownership model remains; the only new Screen state is a short-lived pending action-launch request and a job presentation snapshot.

### 6.2 Result, query, and event rules

`UiResult` remains the only result shape presentation consumes. It is extended, not forked:

- `UiMeta` gains optional `revision`, `jobId`, and a stable request ID where applicable.
- Settings queries return a successful empty/default snapshot rather than treating an absent project config file as an error.
- Configuration source/read/write errors use stable validation, unavailable, conflict, policy, or internal kinds. Raw JSON/OS errors are retained only as safe diagnostic detail.
- Action success returns structured facts and notices. Terminal wording is derived from those facts; it is not parsed back into application state.
- Events gain narrow scopes such as `settings`, `configuration`, `runtime`, `review`, and `connection`. The Screen refreshes only affected projections and preserves selection by identity.

### 6.3 Real job contract

A job is for work backed by an abort-aware asynchronous port, not a wrapper around a synchronous function:

```js
application.jobs.start({
  kind: "settings.write" | "workspace.tree" | "review.git" | "model.validate",
  target,
  run: async ({ signal, reportProgress }) => UiResult,
});
```

Jobs expose queued/running/succeeded/failed/cancelled state, progress message/count, result, and whether cancellation remains meaningful. The StatusBar shows the active job; a compact Job Drawer appears only when there is more than one meaningful item or a failure/cancellation needs inspection.

Cancellation semantics are explicit:

- Before a durable commit boundary, `AbortSignal` stops work and returns `cancelled`.
- After a command/input/durable write has taken effect, cancel means **stop waiting**, not pretend the mutation was undone. The result reports the committed fact and any follow-up refresh.
- Synchronous legacy code is not scheduled as a job until it is migrated to an async port or isolated worker. `queueMicrotask` remains a stack-yield tool only.

### 6.4 Async migration order

1. **Configuration first:** asynchronous source read/revision/atomic write. It is bounded, directly fixes the largest Screen gap, and supplies the first real job/progress case.
2. **Filesystem projections next:** tree, file/report, and workspace reads move to `fs/promises` adapters with `AbortSignal` checks between directory/read batches.
3. **Git/checkpoint reads next:** an abort-aware `spawn`-based Git port replaces synchronous review reads. Write/recovery behavior remains serialized and backend-authorized.
4. **Legacy durable workspace operations last:** structured return values replace text classification operation by operation. No action moves solely because it can be wrapped in a Promise.
5. **CPU-heavy work only if measured:** use an explicit worker/process port with a serializable contract, cancellation, and tests; do not introduce workers speculatively.

## 7. Shared design system and component plan

### 7.1 Retain and standardize existing primitives

| Existing primitive | Planned role |
| --- | --- |
| `tokens.mjs` and `theme.mjs` | Sole semantic palette, emphasis, spacing, color-mode mapping, and no-color fallback source. |
| `Form` | Field rendering/validation/focus base for schema-derived ActionDialog and Settings editor. |
| `ConfirmDialog` | Sole destructive/guarded confirmation component; extended only to display a token/revision-safe request. |
| `CommandPalette` | Search/selection modal; delegates activation to ActionLauncher rather than direct route-only behavior. |
| `createProjectionScheduler` and `AsyncBoundary` | Cached/stale/error/empty query presentation; extended with job status, not replaced. |
| Focus, selection, routes, overlays, notices, key hints | Remain one owner each; no feature-specific copies. |
| `parts.mjs` and feature renderers | Transitional rendering base until collection/detail migration proves visual parity. |

### 7.2 Components to add

| Component | Responsibility |
| --- | --- |
| `CollectionFrame` | Consistent collection header, selected row action bar, empty/stale/error framing, and selection preservation. |
| `DetailPane` | Responsive selected-item inspector; compact mode opens it in place rather than hiding critical state. |
| `ActionLauncher` | Owns pending launch state, target resolution, result presentation, invalidation, and duplicate prevention. |
| `ActionDialog` | Uses action specifications to render fields, help, pending/disabled state, and local validation. |
| `TargetPicker` | Selects a target from an already-settled projection; never reaches into a manager. |
| `SettingsEditor` | Renders config rows, source/provenance details, scope picker, write/reset flow, risk labels, and apply timing. |
| `JobDrawer` | Shows active/failed/cancelled jobs and invokes only meaningful cancellation. |
| `ActionBar` | Route-local direct actions plus disabled reasons; its entries derive from capability/placement data. |

All new components use `TOKEN`/`LAYOUT`, `tokenStyle`, and shared form/focus/overlay behavior. They do not emit bare ANSI colors or define local spacing scales.

### 7.3 Visual rules

- **Semantic feedback:** danger is destructive/error only; warning is policy risk/stale/attention; success is a completed acknowledged operation; focus/selection use interaction tokens rather than a domain color.
- **No-color parity:** text labels, borders, emphasis, and explicit state words carry the same meaning when background/color is unavailable.
- **Collection hierarchy:** identity and status come first; source/risk and concise consequence are next; long diagnostics live in DetailPane.
- **Responsive behavior:** wide terminals may show collection + inspector; compact terminals use one main pane and open inspection; narrow/short terminals use full-window action dialogs, wrapped footer hints, and the palette as an equivalent path.
- **Alias retirement:** feature renderers migrate one surface at a time with snapshot/component tests. A legacy alias is removed only after its last proven consumer is gone.

## 8. Navigation and keybinding map

The existing two-mode model is retained. Printable keys continue to belong to the focused composer/form/palette; global commands do not steal text input.

### 8.1 Stable global map

| Key | Meaning |
| --- | --- |
| `1`–`6` | Chat, Carto, Diff, Shells, Model, Settings |
| `Tab` / `Shift+Tab` | Next/previous tab when not completing typed text |
| `[` / `]`, `H` / `L` | Previous/next subview |
| `j` / `k`, arrows, `g` / `G`, paging keys | Collection navigation/scrolling |
| `Enter`, Space, `o`; `h` / `l` | Existing open/fold semantics |
| `Ctrl+K` | Command palette, now capable of beginning the action-launch flow |
| `?` / `F1` | Complete key sheet |
| `r` | Refresh visible projection |
| `y` / `Y` | Copy selected item / whole tab through existing async export path |
| `Esc` | Leave typing for commands, or allow the active overlay/editor to cancel itself |
| `Ctrl+X` | Stop agent work immediately |
| `Ctrl+V` | Pause/resume current stream |
| `Ctrl+C` | Clear current line; then quit on the existing second-press behavior |

### 8.2 New route-local controls

| Route | Key/control | Meaning |
| --- | --- | --- |
| Carto → Requests | `a`, `n`, `e` | Approve selected move, deny with reason form, answer selected question form. Existing forget/delete confirmation remains `d`. |
| Shells → List | `s`, `d`, `D` | Send line to selected shell, confirm selected close, confirm close all. Enter still opens output. |
| Shells → Wakes | `n`, `e`, `d` | Create wake, replace selected wake, confirm remove selected wake. |
| Chat → Work | `m` | Send a message to the active task through `runtime.task.message`; unavailable state is visible when no task is active. |
| Model → Current accounting | `p`, `N`, `c` | Refresh context top, start fresh context through lifecycle port, request collapse through lifecycle port. Each is disabled while its lifecycle owner says it is unsafe. |
| Settings → Configuration | `Enter`/`e`, `x`, `s` | Edit selected setting, reset selected writable-source override, choose persistence source. |
| Settings → Safety | Action bar/palette | Session approval/initiation/sandbox controls and selector probe. High-risk controls use guarded confirmation instead of a single-letter toggle. |

`Ctrl+K` remains the complete fallback for a capability with no sensible one-key shortcut. Footer hints show only the controls that are enabled for the settled route/selection, while palette entries retain disabled items and their reasons.

### 8.3 Terminal compatibility

Existing slash commands remain valid. The terminal stays a text adapter over the same action/lifecycle results where a shared action exists:

- `/approve`, `/deny`, `/answer`, `/focus`, `/unfocus`, `/undo`, `/send`, `/kill`, `/wakes remove`, `/model`, `/pin`, and `/new` retain their current aliases and acknowledgement wording.
- `/stop`, `/pause`, `/collapse`, `/yolo`, `/initiate`, `/bwrap`, and `/consult probe` map to the lifecycle owner; their existing safety sequencing stays authoritative.
- A later small parser extraction may add `/settings`, `/settings set KEY VALUE`, and `/settings reset KEY` only when its exact grammar and test budget are approved. It is not a prerequisite for the full-Screen Settings editor.
- `/wait` remains line/piped-input-only and is explicitly unavailable in the interactive Screen.

## 9. Implementation sequence after approval

Each slice is a small atomic commit pushed before its verification run. No later slice starts until the earlier contract and tests are stable.

| Slice | Outcome | Primary files | Required proof |
| --- | --- | --- | --- |
| A. Configuration contract | Shared config schema/provenance/repository; typed settings query/edit/reset actions | `configuration/*`, `config.mjs`, `application/{settings,settings-actions,app,contracts}.mjs` | All 30 settings, precedence, validation, atomic conflict/write failure, source permissions, no environment/CLI mutation. |
| B. Settings surface | Configuration/Safety routes, SettingsEditor, source/inspector, session-state display | `screen/{settings,settings-editor,app,key-hints}.mjs` | Selection, compact layout, source shadowing, guarded-policy text, successful/failed/reset feedback. |
| C. Action launcher | Action specifications, placements, ActionLauncher/Dialog/TargetPicker, palette completion | `application/action-specs.mjs`, `screen/{action-*,command-palette,app}.mjs` | Capability-to-launch parity for every current registered action; no manager import in renderer; duplicate action prevention. |
| D. Direct capability gaps | Request answer/deny forms, shell send/close, task message, context/lifecycle controls, wake create/replace | `application/{runtime-actions,lifecycle}.mjs`, `screen/{runtime,workspace,app}.mjs`, `wakes.mjs` | Confirmation, target disappearance, disabled reasons, wake validation, no raw command-start escape hatch. |
| E. True async/jobs | Async config/filesystem first, then Git/review ports; visible jobs/cancellation semantics | `infrastructure/*`, `application/{queries,jobs,events}.mjs`, `screen/job-drawer.mjs` | No synchronous screen/query path for migrated operation, cancellation/race correctness, progress lifecycle. |
| F. Polish/verification | Narrow terminal parser parity where justified, docs repair, renderer alias retirement only when proven | docs, affected feature renderer/tests | Full-Screen PTY flow, resize/no-color coverage, existing safety regressions, aggregate watchdog stays under 10 seconds. |

## 10. Verification strategy

The test budget changes neither the implementation scope nor the acceptance standard. New coverage is compact and deterministic:

| Area | Required evidence |
| --- | --- |
| Configuration | Table-driven tests cover every known key, source precedence, round-trip write/reset, cross-field validation, guarded policy confirmation, revision conflict, and atomic-write failure. |
| Action contract | Each registered capability has one owner, schema/target contract, placement or deliberate boundary classification, availability reason, and terminal path where one exists. |
| Lifecycle | Stop is immediate; pause/resume, collapse/new, policy switching, and probe retain their terminal-owned safety conditions. `/wait` remains Screen-disabled. |
| Wake CRUD | Time/file/window create/replace/remove validation, ID/replacement semantics, max count, project-path restrictions, and selected-row refresh. |
| Async/jobs | Abort before commit, cancellation after effect, stale result rejection, progress events, and no job wrapper around known synchronous code. |
| Screen integration | One deterministic PTY route/action/form/confirmation flow, one compact resize transition, and one no-color/disabled-action flow. Broader behavior stays in fast unit/component tests. |
| Regression | Native grammar fail-closed behavior, offline launch, consultation isolation, approval/sandbox/checkpoint behavior, Ctrl-C/Ctrl-X/Ctrl-V semantics, and 10-second aggregate watchdog. |

Documentation cleanup is part of Slice F: replace the missing `docs/plan.md` reference with the active plan path and correct README's stale test-duration claim after the code/test state being described is final.

## Implementation gate

This plan intentionally stops before code. Approval of this plan authorizes the first implementation slice only: **configuration contract and provenance (Slice A)**. It does not authorize a wholesale rewrite, a test-budget change, or relaxation of any safety boundary.
