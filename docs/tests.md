# Tests

The test policy for Carto. It replaces the generic campaign brief this file
held before, which was written for an unknown repository and contradicted the
person on when tests run.

## The rule that comes first

**Pushing and verifying are different acts.** Commit and push as you go,
mid-stage — half-finished is fine. Origin is what stands between you and a
reset workspace, and nothing pushed is lost. A mid-stage push implies no
verification of any kind.

**Tests run once, at the very end of the stage**, when you are ready to tell
the person the work is done. Every edit you expect the stage to need is made,
and then you run `npm test` — the build is only the first step inside that one
command. Never between edits, never mid-stage, never as a check on progress.

This is not ceremony. A test run during a stage turns you into a machine that
watches a progress bar and calls it confidence. The build is the gate that lets
you say you are done; the tests are what catch you being wrong about that.
One example of the ban is worth repeating: a build, one-off test, or probe
during a stage is the same mistake as a test during a stage — the budget is
the end of the stage, and nothing else in the middle is allowed to consume it.

## Commands and budget

| Command | When | Budget |
| --- | --- | --- |
| `npm test` (build + suite) | At the end of the stage, once, after every edit is made | the suite must finish in **10 seconds, total** |

`npm test` is `npm run build && node test/guard.mjs`. The build is the first
step inside it. Nothing else in this file — or anywhere else — runs builds,
tsc, or tests: a build, one-off test, or probe mid-turn is the same mistake as
a test mid-stage and is banned outright.

The budget is the **whole suite**, not a per-test allowance. The guard aborts
the run at 10 seconds and tells the agent it is taking too long — that abort
is a failure, not a pass. The suite overrunning the budget means something is
wrong with the test, not with the budget. The usual cause: a test that sleeps
to let a watcher fire, or a test that polls until a durable task settles. The
fix is to improve the slow test or drop the worst offender — and to re-run —
never to add a per-test exemption, never to shorten or raise the budget by
hand.

## What a test must earn

A test earns its place by catching a break that matters. Before adding one, name
the break. If you cannot name a change that would make it fail, it is not a test.

These do not earn their place:

- A test that mirrors the implementation: it asserts that a function calls what
  it calls, so it fails on every refactor and on no defect.
- A second test for the same break through a different door.
- A test whose only failure mode is the platform it runs on.
- Fixtures and mocks nobody reads.

Removing these is a deliverable. Report it as one.

## Probes are not tests

A probe is a scoped check for something you are not yet sure works: a PTY
transcript, a script against a fake server, a one-off in `/tmp`. Run it at the
end of the stage, after the push, when you need it, and do not commit it.
A probe is forbidden at any other time — mid-turn, mid-stage, mid-slice, or as
a progress check.

A probe cannot replace a test, cannot be counted as one, and cannot be used to
dodge the budget. If a probe proves something worth keeping, the next stage
turns it into a test at that time.

## What to protect

Read the product code before its tests. The contracts worth a guard are the ones
the specification makes promises about. In Carto those are:

| Area | The promise |
| --- | --- |
| Handles | Records are named by generation-local handles; raw durable IDs are refused |
| Brain | One current document per project, `history: "latest"`, latest state wins |
| Context | The projection the person sees is the projection the model is sent |
| Chat | Chat is never collapsed by default; a fold is manual and stays in context |

Platform and integration boundaries are kept when they protect distinct
behaviour: SQLite storage, a real HTTP stream, a real PTY. Keep one of each, not
one per test.

## Ledger

Keep a short ledger of what each stage removed and what guard it left behind. It
records coverage and gaps, not a score.

### Stage: tests audit (campaign) — live session and tools, 2026-11-21

- Read `runtime/live-session.ts`, `runtime/tools.ts`, and `runtime/workspace.ts`
  (for the boundary) before their tests.
- Removed: the standalone read-output test. The bounds test already asserts the
  same `path:start-end (of N lines)` format for whole-file, from-line, and
  through-line reads, and already asserts the excerpt carries the file text.
  The removed test's only unique assertion was that the output does not
  contain "digest" — a negative against a framing the specification dropped,
  guarding no current behaviour.
- Every retained test names its break: a full turn's Brain write, pending
  line, and trailing marker-free block; the continuation marker; read feeding
  an Atlas attachment; the tree tool moving the anchor; the `.brain`/escape
  boundary; open read bounds and past-the-end rejection; unknown handles as
  explicit errors; agent- and person-triggered collapse, including drift
  riding the rebuild; the bash round trip; and interrupt settling a run with
  an open bash call.
- Known risk, untouched: the interrupt test sleeps 1.5s to let the bash task
  start, under a 20s ceiling — the suite's main wait. It is the only guard for
  its break and no deterministic replacement is obvious, so it stands.
- Suite 98 → 97. Boundaries preserved: the faux provider, real temporary
  files, and the real bash round trip.

### Stage: tests audit (campaign) — project tree and ignore rules, 2026-11-21

- Read `runtime/project-tree.ts` and `runtime/gitignore.ts` before their tests.
- Removed: the third aggregate-arithmetic test in the ignore-rules file. It
  re-asserted, with a second fixture, that an ignored directory contributes no
  bytes while the `.gitignore` itself counts — the first test in that file
  already guards both and also asserts the render. Same break, second door.
- Every retained test names its break: render order and honest aggregates;
  depth bounds; Atlas handle marks with relative and absolute attachment
  paths; attachment escape rejection; anchor errors; symlink-as-leaf;
  `.brain`/`.git` hidden from the listing and the aggregate; anchors into them
  rejected; and the gitignore semantics — anchored rules, basename-at-depth,
  negation, last-rule-wins, nested files, `.git/info/exclude`, directory-only
  rules, double-star, and the pruned-directory re-include limit.
- Suite 99 → 98. Boundary preserved: real temporary directories.

### Stage: tests audit (campaign) — collapse, freshness, projection, state block, 2026-11-21

- Read `domain/projection.ts`, `domain/state-block.ts`, `domain/freshness.ts`,
  `domain/estimate.ts`, `runtime/collapse.ts`, and `runtime/projection-files.ts`
  before their tests. No unearned tests found; nothing removed.
- Coverage confirmed: newest-first discovery; a crashed head purged; one
  sealed archive with older remainders purged; seal → new generation → purge
  after the exports seam; the byte-stable frozen snapshot; drift by mtime
  (newer stale, older fresh, missing stale) with non-file attachments unchecked
  and handles surviving a refresh; the projection's handles, timestamps, no
  raw ids, no chat text, `(gone)` links, ledger answers, inline pins, and the
  nothing-omitted guard; the block's contents and delimiters, its `none` and
  unknown-window forms, marker stripping, exclusive token buckets, and the
  trailing append.
- Suite 99 → 99. Boundaries preserved: real temporary files and a real SQLite
  Brain store.

### Stage: tests audit (campaign) — Brain writes, storage, handles, 2026-11-21

- Read `domain/brain.ts`, `domain/records.ts`, `domain/handles.ts`, and
  `runtime/brain-store.ts` before their tests. Every retained test names its
  break: append, update, and upsert semantics; links stored as written; no
  cascade on delete; pin and stale as markers that clear by key removal;
  single-step delete with explicit unknown-id errors; handle assignment and
  reconcile; and the real-SQLite round trip, delete persistence, and
  corrupt-document rejection.
- Removed: the `ledger.upsert` test's closing assertion that a fixture-built
  entry has the kind it was built with — a tautology about the test's own
  literal, guarding no production behaviour. The test is retitled to what it
  actually guards.
- Strengthened in place: the compact test now asserts the Brain still reads
  after secure-delete and VACUUM, so it fails if compaction loses the document,
  not only if it throws.
- Suite 99 → 99 (one assertion removed, one strengthened). Boundary preserved:
  the real SQLite file.

### Stage: tests-doc reconciliation + audit, 2026-11-21

- `docs/tests.md` was stale against the corrected rule — the commands/budget
  table still said `tsc` then `build` before the push, and a "test that needs
  longer" exemption survived beside the budget. Rewritten: the build is only
  the first step inside `npm test` (which runs the whole suite under the
  `test/guard.mjs` abort at 10 seconds); no one-off tests, no probes outside
  the end-of-stage sequence; the budget is the whole suite, with no per-test
  allowance.
- Audited the suite against the doc. Every retained test earns its place; no
  unearned tests found. Two assertions strengthened in place, not padded:
  - The ContextView fixture was stale (it fed `{ role, content }` messages
    and a tool-work shape the view never read); the fixture now renders the
    real shape, and the delete flow now asserts it targets the selected
    transcript message (t-1), not a phantom.
  - The sidebar test's 4-way OR over token-count encodings was tightened to
    the deterministic render (~1k) — the guard is the width loop, not the OR.
- Guard left behind: the real loopback HTTP socket, the faux provider, and the
  one CLI-end-to-end per area; the 99-test suite runs well under the 10s
  budget (measured ~5.3s on the final green run).

### Stage: test-suite audit (the campaign brief), 2026-11-20

- The suite was read end to end against its production code; every retained
  test names the break it catches. Deleted what did not earn its place,
  consolidated what covered the same break twice, and strengthened weak
  assertions in place rather than padding the count.
- Removed (and re-scoped 2026-11-21 with the evidence/edge cut): the
  `contradicts`-edges storage test (duplicate of the
  storage-as-written guard — the same break through a second door; the
  no-cascade law stays covered by the deletion test); a tautological
  `total`/`sizes` assertion pair in the projection test (it re-derived the
  implementation definition; replaced with a nothing-is-omitted guard —
  all 50 ledger entries render in the frozen text); a dead `linked`
  fixture map and its no-op assertion in the project-tree symlink test; a
  duplicated `.brain` rejection in the live-session read test (the
  shared wall is guarded by "the boundary holds").
- Strengthened in place: `splitContextMessages` now asserts exclusive
  bucket attribution (an empty bucket reports zero, not a share of the
  rest) instead of "everything > 0".
- Housekeeping: the misleading "delete removes links" title corrected to
  state the law (no cascade; links stay as written); the CLI test helper's
  vestigial `cwd` parameter and dead variable removed; an unused
  `void faux` dropped.
- Suite 74 → 73. Boundaries preserved: SQLite (brain-store), the faux
  pi-ai provider, one real loopback HTTP socket for the catalog refresh,
  the spawned CLI end to end. Nothing was added to keep the count up.

### Stage: from-scratch rebuild, 2026-11-20

- `src/` and `test/` were deleted in full and rebuilt from `MINI.md` (the
  person's order: delete it all; re-doing slice 1 was fine; asking beats
  assuming). Suite shrank from 58 to 15 and regrew to 29 as R1 and R2
  landed, then to 34 with the state block, 40 with the project tree, and
  50 with R3's tools and live session, 69 with R4's config, capacity,
  provider, driver, and CLI coverage, 70 with the interactive-terminal
  fix, and 74 with the dependency-first pass: the built-in bash tool's
  round trip through the environment, interrupt-settles-a-run whose bash
  call is open, pi-ai's catalog refresh over a real local socket
  (cold → advertised), and the deterministic applyCapacityRefresh unit.
  Note: an earlier version of the refresh test relied on outbound
  connection-refusal timing and hung the suite; it was replaced with
  deterministic tests. A person's rig should still run the real boot
  once — that path is only mocked here.
- As of R4 (2026-11-20): config load/save/override semantics; capacity
  discovery against injected fakes (field order, strict id match,
  never-throws, pin-wins semantics); the llama-swap provider's registry
  output; the headless driver end to end against the faux provider
  (chat-only person output, the no-chat parenthetical, /collapse, exit at
  stdin EOF); the capacity refresh lowering the live window after a turn;
  the CLI end to end with a scratch CARTO_HOME (--help, the missing-config
  one-liner, config creation, headless boot and clean EOF exit, an
  unsupported provider failing before any request). Known limits: nothing
  here proves a real llama-swap server answers — the person verifies.
  Still no test of a real provider or of a screen.
- As of R3 (2026-11-20): the live session runs against a faux pi-ai provider,
  end to end — a full tool turn with the pending list asserted by handle;
  the `onYield` continuation with the marker asserted present in the store
  and absent from the payload; `read` feeding `atlas` file attachments;
  the `tree` tool moving the anchor; an agent-triggered collapse through the
  ceremony with attachment-drift marks riding the rebuild; a person-triggered
  collapse with no run in flight. Known limit: a tool-calling reply only
  enters a tool round with stopReason `toolUse` — the faux scripts set it,
  and real providers do the same. The ten-second budget is still unaddressed;
  the live-session tests are fast (faux, no waits) but nothing measures them.
- Still open: no test of a real provider, nothing about a screen. R4
  (config, llama-swap, the headless driver) brings its own.

### Stage: UI teardown, 2026-11-16

- The UI was torn out whole: `src/ui/`, the `src/runtime/ui.ts` app shell, the
  token-meter domain math (`domain/meter.ts`), the Context-tree builder
  (`domain/prompt-tree.ts`), and the prefill monitor (`runtime/prefill.ts`)
  are deleted. `test/{frame,screen,ui,context-tree,input}.test.mjs` went with
  them.
- 109 tests became 58. `npm test` is green on the remaining suite. The
  ten-second budget is unaddressed, as it was before; the prefill-monitor
  wait is gone with the monitor, which removes ~50 ms of the debt.
- Gap: the domain, the runtime, and the headless placeholder driver in
  `src/cli.ts` are all that remain guarded. None of them proves anything
  about a screen, because there is no screen.

### Stage: cleanup, 2026-11-16

- Deleted `docs/intent.md` (110 lines of unconfirmed inference) and rewrote this
  file for Carto.
- Measured before the policy took effect: the full run was 26 seconds, against a
  10 second budget. Four waits were responsible: a 1.25 second path-wake test
  (gone with the wakes teardown, 2026-11-20), two `eventually` loops with 4 second
  ceilings, and a 50 millisecond sleep in the prefill monitor test.
- Outstanding: none of the above are fixed yet. The next stage that touches those
  tests must bring the run under budget or record the guard it drops.
