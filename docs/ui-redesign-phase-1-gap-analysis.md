# UI redesign — Phase 1 gap analysis

**Date:** 2026-11-16
**Scope:** audit and discovery only. No product code is changed by this report. Phase 2 has not started.

## Executive result

Cartographer already has a substantial incremental redesign: a six-tab `pi-tui` Screen, a plain-terminal adapter, semantic theme tokens, settled projections, a 30-action application registry, typed UI results, deferred projection scheduling, shared form/confirmation/focus primitives, and broad component-level coverage.

The remaining gaps are not a reason to replace the application wholesale. They are concentrated at the edges the earlier migration deliberately left transitional: complete user control of configuration and runtime policy, true non-blocking I/O, direct capability invocation from the Screen, a fully thin terminal adapter, and end-to-end Screen verification.

No direct durable Screen mutation was found in this audit. Existing native-grammar, consultation isolation, approval, checkpoint, sandbox, and terminal-lifecycle safeguards remain constraints for any later work.

## What was audited

| Area | Evidence inspected |
| --- | --- |
| Product and runtime | `README.md`, `package.json`, `src/cli.mjs`, `src/config.mjs` |
| Domain/backend | `src/*.mjs`, `src/tools/*.mjs`, `src/application/*.mjs` |
| Full Screen and terminal | `src/screen/*.mjs`, `src/terminal.mjs` |
| Existing redesign record | `docs/ui-redesign-plan.md`, `docs/design.md` |
| Verification | `test/all.mjs`, `test/unit.mjs`, `test/run.mjs` |

### Observed architecture

```text
Domain modules and tool implementations
        ↓
Application queries, typed action adapters, capabilities, events, and jobs
        ↓
Full Screen adapter (src/screen/) and plain-terminal adapter (src/terminal.mjs)
        ↓
pi-tui terminal UI / line-oriented terminal
```

- **Language/runtime:** Node.js ESM (Node 22+).
- **TUI:** `@earendil-works/pi-tui`; the full Screen has Chat, Carto, Diff, Shells, Model, and Settings.
- **Durability/backend:** `pi-durable` SQLite session data plus project-local `.brain/` JSON/Markdown records, checkpoint Git storage, local llama.cpp-compatible `/v1` transport, and Bubblewrap-backed command staging.
- **Application boundary:** `createApplication()` composes 30 action IDs: Context 2, Requests 3, Review 2, Runtime 7, Talk 2, and Workspace 14.

## Strengths already present

1. **Consistent Screen shell.** `src/screen/app.mjs` owns a persistent six-tab shell, two-mode interaction model, shared status strip, notices, route selection, overlays, command palette, footer hints, and key help.
2. **Design-system foundation.** `src/screen/tokens.mjs` and `theme.mjs` provide semantic surfaces, text, borders, interaction states, feedback, activity/domain tokens, truecolor/256/no-color modes, and shared spacing rules. `Form`, `ConfirmDialog`, `CommandPalette`, list selection, focus, overlays, and async boundaries are reusable primitives.
3. **Typed UI boundary.** `UiResult`, stable error codes/kinds, capability availability, confirmations, cancellation, and projection invalidation exist in `src/application/`.
4. **Safety is retained.** Destructive Screen actions request scoped confirmation; model selection still validates native GBNF; consultation stays isolated; and the Screen routes durable actions through `application.execute` rather than mutating workspace/runtime managers itself.
5. **Good component-level proof.** Tests cover settled/loading/stale/error/empty projections, forms, dialogs, focus, selections, routes, palette filtering, action ownership, all 30 capability destinations, theme rendering, and key/help text parity.

## Gap analysis

### P1 — Full configuration and policy control is not exposed through the Screen

`src/config.mjs` defines **30** user settings. The Settings snapshot exposes 14 configuration values and reports three session policy states (`yolo`, `initiate`, `bwrap`), leaving 13 defaults absent from the Settings projection:

```text
user, wakesMax, shellRead, treeDepth, screen, repeatCut, prefill,
prefillTokens, askMinutes, thinking, handoffQuestion, collapseFull, readAhead
```

`src/application/settings.mjs` and `src/screen/settings.mjs` are explicitly read-only. There is no `SETTINGS_ACTION`, configuration writer, source/precedence projection, or full-Screen configuration editor. The user must hand-edit config files or use the limited session commands.

**Impact:** this does not meet the requested “every configuration setting accessible and actionable via the TUI” outcome. It also hides configuration provenance: install config, project config, environment variables, and command-line overrides have different persistence and precedence but are not presented as editable sources.

**Phase-2 decision needed:** classify each setting as one of: display-only policy fact; safe live/session override; project-config edit that applies next run; install-level edit; or intentionally environment/CLI-only. Do not make sandbox/approval controls broadly mutable merely to satisfy exposure.

---

### P1 — The non-blocking contract is only partially implemented

The Screen does not read or mutate domain state during rendering, and `createProjectionScheduler()` cancels/supersedes deferred reads correctly. However, the work after that deferral is still often synchronous on the Node event loop:

- `src/application/defer.mjs` uses `queueMicrotask`, which yields the caller stack but does not move work off the event loop.
- `src/application/queries.mjs` imports and uses `readFileSync` and `statSync`, then calls established synchronous domain loaders and project discovery.
- `src/application/workspace.mjs`, `requests.mjs`, and `review.mjs` yield before calling synchronous legacy mutation/checkpoint operations.
- `createJobManager()` is composed by `createApplication()` but no production code calls `jobManager.start()`.

**Impact:** render/key stacks are protected, but large trees, Git/checkpoint reads, report reads, or durable mutations can still stall input after their microtask begins. Progress is not surfaced as a real job lifecycle and cancellation cannot preempt synchronous work.

**Phase-2 decision needed:** identify the first bounded high-cost operations to migrate behind Promise-based filesystem/Git/process adapters, with cancellation checkpoints and job progress. Preserve domain safety semantics; do not turn writes into optimistic UI operations.

---

### P1 — Capability discovery is stronger than direct Screen execution

The palette materializes every registered capability and correctly preserves its availability reason. Selecting a capability in `showPalette()` currently navigates to a destination; it does not invoke the capability. Screen-local controls directly cover workspace rows/forms, kept talk, Diff undo, wake removal, and model route selection. Other actions remain reachable through the full Screen’s slash-command composer, for example `/send`, `/kill`, `/pin`, `/new`, and `/approve`.

This is an intentional safety-oriented route-to-context pattern, but it leaves interaction uneven:

- context pin/clear are terminal-command flows, not Screen controls;
- shell send/close/close-all are terminal-command flows, not list/output actions;
- request denial/answering require composer syntax rather than shared forms;
- task steering is implicit through the composer rather than a focused Runtime control;
- the palette cannot collect required target/input or show a capability-specific form.

**Impact:** every registered action is discoverable, but “capability appears in the palette” does not mean “action can be completed from the palette or selected row.” This is a UX completeness gap, not a reason to bypass confirmation or move authority into the renderer.

**Phase-2 decision needed:** define a uniform action-launch contract: destination, target resolver, input schema/form, confirmation policy, and terminal alias. Actions that are intentionally command-only must say why.

---

### P1 — Backend capability ownership needs an explicit user-facing classification

Some backend tools are deliberately agent-only or safety-gated, while the prompt’s full-exposure goal asks for every backend capability to be actionable from the UI. Current examples:

- `wake` supports agent-side scheduling, while user-facing Screen/terminal controls list and remove wakes but do not create or edit them.
- Command starts remain restricted to declared, authorized moves; Screen users can inspect, send input to, or close windows but cannot start arbitrary shell commands.
- Runtime policy switches (`/yolo`, `/initiate`, `/bwrap`) remain terminal-core lifecycle controls rather than registered application actions.
- `/collapse`, `/new`, `/stop`, and `/pause` are lifecycle controls owned by the terminal core.

**Impact:** these are not necessarily missing features: unrestricted exposure would weaken the project’s approval and sandbox guarantees. But the product has no explicit matrix distinguishing user-actionable, agent-only, lifecycle-owned, and deliberately unavailable operations.

**Phase-2 decision needed:** publish that matrix before adding controls. It is the guardrail that prevents “full backend exposure” from becoming unsafe raw-manager access.

---

### P2 — The terminal is still a hybrid adapter, and some contracts are text-derived

The full Screen is mostly projection/action based, but `src/terminal.mjs` still imports domain renderers/managers and performs terminal-lifecycle work directly. This is deliberate for reader/key handoff, stream pause/stop, wake processing, sandbox switching, and session reset, but it means the terminal is not yet a thin presentation adapter.

Likewise, `src/application/workspace.mjs` wraps legacy `src/ops.mjs` output through `workspaceOutcome()`, which classifies success/error states by matching human-readable strings. That is a transitional compatibility seam, not a fully standardized backend result contract.

**Impact:** wording changes can alter action semantics, and terminal/domain coupling remains broader than the target architecture. This should be reduced selectively, not by removing lifecycle seams that enforce safety.

**Phase-2 decision needed:** identify which lifecycle controls must stay terminal-owned and which legacy `ops` operations should first return structured domain outcomes. Preserve existing behavior until parity is proven.

---

### P2 — The design system is centralized but not yet fully semantic end to end

Semantic tokens and responsive shell primitives exist. `src/screen/tokens.mjs` also retains `LEGACY_STYLE_ALIASES`, and the current Phase 6 record explicitly says active renderers still rely on them. Feature views return bespoke list-row shapes; there is no common table, detail-pane, or inspector contract shared across Workspace, Review, Runtime, and Settings.

**Impact:** visual consistency is substantially improved, but strict component reuse and semantic-only styling are not complete. A later migration must prove renderer parity before aliases are removed; deleting them now would be speculative and unsafe.

**Phase-2 decision needed:** define the minimum shared collection/detail contract worth building next, plus a renderer-by-renderer alias retirement plan. Do not force a directory reshuffle without behavioral evidence.

---

### P2 — Job/progress semantics are not connected to visible long-running work

The application has an event stream and a job manager, but production actions and queries do not start jobs. The status strip can show live agent activity, but there is no common user-visible job list, progress state, or cancellation affordance for deferred Git/filesystem/model-route work.

**Impact:** loading and stale states exist, but the requested progress/non-blocking lifecycle is not complete for operations that may be slow.

**Phase-2 decision needed:** decide whether jobs are needed only for heavyweight local operations or also model-route checks, previews, exports, and editor handoffs; then define cancellation semantics that distinguish “cancel waiting” from “operation already changed durable state.”

---

### P3 — Full-Screen end-to-end verification is narrow

The suite has strong unit/component coverage and a pseudo-terminal full-Screen launch check. The full-Screen pseudo-terminal case currently proves offline server errors remain visible and exits with Ctrl-C. The test tree has no direct `runScreen()` harness and no scripted full-Screen workflow covering navigation, selected-row actions, modal confirmation, palette routing, resize transitions, or no-color interaction end to end.

Static component tests exercise several widths (including 35, 80, and 120 columns), but there is no terminal resize matrix or interactive color-mode workflow test.

**Impact:** the components are well specified, but integration confidence for the composed Screen is weaker than for the plain terminal.

**Phase-2 decision needed:** choose a compact deterministic PTY coverage set that stays within the immutable 10-second aggregate watchdog: one navigation/action/modal workflow, one compact resize transition, and one no-color/disabled-action assertion are likely higher value than broad snapshot coverage.

---

### P3 — Documentation has two concrete stale references

1. `docs/design.md` says `docs/plan.md` carries the active delivery sequence, but no `docs/plan.md` exists in the repository.
2. `README.md` describes `npm test` as “about three and a half minutes,” while `test/all.mjs` enforces a 10-second aggregate budget and the current suite is designed to finish within it.

**Impact:** these undermine the otherwise strong documentation contract and can misdirect future work.

## Keybinding and state-management findings

- No current contradiction was found among the six-tab registry, `KEYS_HELP`, README key map, Screen composer entries, and terminal aliases; the existing parity tests cover the declared behavior.
- The two-mode interaction model intentionally differs from a conventional single-mode `Esc`/`q` model: Esc moves typing to commands, and overlays own their own cancellation. This is a product choice, not an audit failure.
- Route, focus, selection, overlay, notice, and deferred projection ownership are clear in the Screen. Durable business state and capability availability live behind the application facade.
- The main remaining state-management concern is the transition boundary: lifecycle controls and synchronous legacy operations still cross adapter/domain seams directly or via a microtask yield.

## Phase 1 conclusion

The codebase is ready for a **targeted Phase 2 architecture and design-system plan**, not a rewrite. The plan must first resolve the P1 decisions above: configuration/policy ownership, capability classification, action-launch contract, and the first true asynchronous migration slice. It must keep the existing safety model and the 10-second verification budget intact.

**Stopped here for approval, as required by the workflow.**
