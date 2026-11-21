# The tests audit

A standing brief for a sustained cleanup campaign over Carto's test suite. It
is the project-specific form of a generic campaign skill: every rule below is
this repository's rule, and the generic phrasing that does not fit is named
and overridden rather than carried along.

**Authority.** `AGENTS.md` and `docs/tests.md` outrank this file. This file is
a playbook — a plan, authority level 5. Where a habit from a generic campaign
brief conflicts with those two, those two win. The conflicts are called out
below.

## The project this campaign runs on

Carto is a durable agent for one person and one project: the Brain (Atlas,
Ledger, Chat), the projection and its handles, the state block, collapse and
the archive, the workspace boundary, and the workspace TUI. It is Node
`>=22.19`, TypeScript, ESM, built on `@earendil-works/pi-tui`, `pi-durable`,
`pi-ai`, `chord`, and `pi-schema` (all 1.5.2).

Tests are `.mjs` files under `test/`, run with `node --test`, and they import
the compiled output from `dist/`. The build is therefore part of every
verification — a test cannot pass against a tree that does not compile.

The suite today: **99 tests in 12 files**, measured at roughly 5.3s against
the 10-second budget (`docs/tests.md` ledger, 2026-11-21). Two audit passes
have already run (2026-11-20 and 2026-11-21); this campaign resumes from their
ledger, not from zero.

## The rule that comes first

**Pushing and verifying are different acts.** Commit and push as you go,
mid-stage — half-finished is fine, and a mid-stage push claims no verification.
Origin is what stands between the campaign and a reset workspace. A campaign
stage that is not pushed is a stage that can be lost.

**Tests run once, at the very end of the stage**, when every edit is made and
you are ready to report done. The fixed sequence:

1. Read the production code for the subsystem, then its tests.
2. Make every edit the stage needs — deletions, consolidations, repairs.
3. Run `npm test` — `npm run build && node test/guard.mjs`. The build is the
   first step inside it; the suite is the rest.
4. Commit and push.
5. Append the ledger entry (see below).
6. Report, naming what was removed and what guard was left behind.

The budget is the **whole suite, 10 seconds, wall clock**. The guard aborts at
10s and exits 1; that abort is a failure, not a pass. The fix is to improve
the slow test or drop the worst offender, then re-run — never to shorten the
budget, never to run a partial suite, never to add a per-test exemption.

The generic brief's "run the affected checks" and "follow the test-line budget"
do not exist here. There is no partial run and no line budget. `npm test` is
the only check, it runs whole, and the count is a measurement, not a target.

## What a test must earn

A test earns its place by catching a break that matters. Before keeping one,
name the break. If you cannot name a change that would make it fail, it is not
a test.

These do not earn their place, and removing them is a deliverable:

- **Implementation mirroring** — it asserts that a function calls what it
  calls, so it fails on every refactor and on no defect.
- **Duplicate coverage** — a second test for the same break through a
  different door.
- **Platform-only failure modes** — a test whose only failure is the OS it
  runs on.
- **Dead fixtures and mocks** — builders, stubs, and fakes nobody reads.
- **Tautologies** — assertions that re-derive the implementation's own
  definition (a `total` equal to the sum it just summed).

Do not chase a deletion percentage. Do not add replacement tests to keep the
count up. Do not delete the only guard for a real break to make a failure
disappear.

## Where the campaign starts: the subsystem inventory

Work through every row. A row is done when each retained test in it names its
break, and the ledger says what was removed and what guard remains.

| Subsystem | Production code | Test file | The contract guarded |
| --- | --- | --- | --- |
| Brain writes | `domain/brain.ts`, `domain/records.ts` | `brain.test.mjs` | `applyWrite` semantics: append, update, upsert, links as written, no cascade on delete, pin/stale as markers on the entry, single-step delete, unknown ids throw |
| Brain storage | `runtime/brain-store.ts` | `brain-store.test.mjs` | Real SQLite round trip; delete persists; a corrupt document throws rather than reading empty; compact runs |
| Collapse and generations | `runtime/collapse.ts`, `runtime/projection-files.ts` | `collapse.test.mjs` | Newest-first discovery; a crashed head is purged; one sealed archive; seal → new generation → purge after exports; the frozen snapshot is byte-stable |
| Freshness | `domain/freshness.ts`, `runtime/collapse.ts` | `freshness.test.mjs` | Attachment drift by mtime: newer is stale, older is fresh, missing is stale; non-file attachments unchecked; a refresh marks and clears, handles survive |
| Ignore rules | `runtime/gitignore.ts` via `project-tree.ts` | `gitignore.test.mjs` | Git parity: anchoring, basenames, negation, nested files, `.git/info/exclude`, directory-only rules |
| Handles | `domain/handles.ts` | `handles.test.mjs` | Contiguous prefixes in creation order; reconcile keeps, drops, numbers newcomers; unknown handles resolve to nothing |
| Live session and tools | `runtime/live-session.ts`, `runtime/tools.ts`, `runtime/carto-extension.ts` | `live-session.test.mjs` | A full turn: Brain write, pending list by handle, block trailing and marker-free; the continuation marker; read → atlas attachment; the tree tool; the boundary; read output and bounds; agent and person collapse; bash round trip; interrupt settles the run |
| Project tree | `runtime/project-tree.ts` | `project-tree.test.mjs` | Render order and honest sizes; depth; Atlas marks; escape rejection; anchor errors; symlinks are leaves; `.brain`/`.git` never listed or aggregated |
| Projection | `domain/projection.ts` | `projection.test.mjs` | Atlas structure, handles, timestamps, no raw ids; chat text absent; a link to a deleted node renders `(gone)`; ledger answers; pins inline; nothing omitted |
| Config and capacity | `runtime/config.ts`, `runtime/llama-swap-model.ts`, `runtime/headless.ts`, `src/cli.ts` | `r4-config.test.mjs` | Model-ref parsing; config validation, creation, override, corrupt-file error; capacity advertisement precedence and pin-wins; registry refresh, including a real HTTP socket; failed refresh retains; the headless driver; `applyCapacityRefresh`; the CLI end to end |
| State block | `domain/state-block.ts` | `state-block.test.mjs` | The confirmed contents and delimiters; `none` and unknown-window forms; marker stripping; exclusive token buckets; append leaves the block last |
| Workspace views | `ui/*.ts` | `ui-views.test.mjs` | Pad/width invariants; sidebar render and mouse; transcript fold, live header, pin badge; context view navigation, folding, delete and collapse; atlas/ledger two-pane; tool-arg formatting |

Modules with no direct test import are covered transitively or are the
campaign's known gaps: `domain/estimate.ts` (through projection, state block,
context view), `runtime/workspace.ts` and `runtime/digest.ts` (through
`tools.ts`), `runtime/paths.ts` (through the CLI), and `ui/app.ts` with the
chrome, token bar, palette, jump, clipboard, and dump modules (through the
view-level tests only — nothing drives the composed TUI).

## What to protect

The contracts worth a guard are the ones `MINI.md` and `docs/intent.md` make
promises about. `docs/tests.md` names the core four:

| Area | The promise |
| --- | --- |
| Handles | Records are named by generation-local handles; raw durable IDs are refused |
| Brain | One current document per project, `history: "latest"`, latest state wins |
| Context | The projection the person sees is the projection the model is sent |
| Chat | Chat is never collapsed by default; a fold is manual and stays in context |

Around those: the state block is one trailing user message and the payload
carries no marker; collapse seals the old generation, creates a fresh one, and
purges only after exports; `.brain` is invisible to every tool and every tree;
the config pin always wins over an advertised capacity.

**Boundaries are kept when they protect distinct behaviour — one of each, not
one per test.** This suite's boundaries are: a real SQLite file
(`brain-store.test.mjs`), a real loopback HTTP socket (`r4-config.test.mjs`,
catalog refresh), the faux pi-ai provider (`live-session.test.mjs`,
`r4-config.test.mjs`), the spawned CLI (`r4-config.test.mjs`), and real
temporary directories for filesystem behaviour. There is no PTY test today;
if the campaign adds one, it must be one, deterministic, and cheap. Do not
replace a boundary with a mock, and do not duplicate a boundary per test.

## The campaign loop

For each subsystem, in order:

1. **Read the production code first.** The contracts are in the code and in
   `MINI.md`/`docs/intent.md`, not in the test names.
2. **Classify every test**: keep, strengthen in place, consolidate, or delete.
   Consolidation happens around the strongest behaviour check — the one that
   fails for the real defect, not the one that fails for a convention.
3. **Name the break** each retained test catches, in one line, in the ledger.
4. **Repair flaky tests; do not preserve their retry tax.** The known cost
   centre is `live-session.test.mjs`'s interrupt test: a 1.5s sleep to let the
   bash task start, under a 20s ceiling. Touch it only with a deterministic
   replacement, and never add a new wait to prove a point.
5. **Do not offset growth by deleting an independent safety contract.** New
   coverage must be justified by a named break, not added to pad a replacement
   suite.
6. **Do not stop after the easy deletions.** A campaign that only removes the
   obvious dead weight has not worked through the subsystems.

## Demonstrating a guard

The generic brief asks for proof that a retained test fails for the broken
 behaviour. Here, proof by reading is the default: name the exact assertion
that a named defect would trip. When that is not practical, the only permitted
form is a **post-push probe** — break the production line the test guards,
run that one test file, watch it fail, restore the file, throw the probe away.
A probe is never kept, never counted as verification, and never run mid-stage.
It cannot substitute for `npm test`, and it cannot be used to dodge the budget.

## The ledger

The ledger lives in `docs/tests.md` — one entry per stage, appended, never
rewritten. An entry records: the areas completed; what was removed or
consolidated and why it did not earn its place; the guard left behind for each
break; the coverage gaps and unresolved risks that remain; and the suite's
measured time against the 10s budget. The campaign resumes from that ledger at
the start of each stage, and it is complete when every row of the inventory
above has an entry and the remaining risks are either accepted or listed.

## Stop conditions

- A test that protects confirmed intent in `MINI.md` or `docs/intent.md`
  stays, even when it is expensive.
- If a deletion would leave a real break unguarded, stop and keep the guard.
- If the tree contains something the code and the documents do not explain,
  stop and ask. Do not improvise a recovery, and do not delete to make a
  mystery disappear.
