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
the person the work is done. Every edit you expect the stage to need is made;
`tsc` and `npm run build` exit zero; you commit, push, and only then run the
suite. If a test fails, fix it, build, push again, and test again. Never
between edits, never mid-stage, never as a check on progress.

This is not ceremony. A test run during a stage turns you into a machine that
watches a progress bar and calls it confidence. The build is the gate that lets
you say you are done; the tests are what catch you being wrong about that.

## Commands and budget

| Command | When | Budget |
| --- | --- | --- |
| `npx tsc --noEmit` | At the end of the stage, before the push | Fast |
| `npm run build` | At the end of the stage, before the push | Fast |
| `node --test test/*.test.mjs` | At the very end, after the push, before you report done | **10 seconds, hard** |

The 10 second budget is the test run alone. The build is not inside it. `npm
test` is `build && node --test`, so the gate runs twice when you use it; that is
acceptable, but the measured number in a status line is the run.

Longer than 10 seconds means something is wrong with the test, not with the
budget. Real waits are the usual cause: a test that sleeps to let a watcher
fire, or that polls until a durable task settles. A wait is allowed when it
crosses a boundary that genuinely lives outside the test, and only with a
comment on that test saying which boundary and why it cannot be injected.

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
| Wake | A durable wake stays armed until its condition is met, and fires once |

Platform and integration boundaries are kept when they protect distinct
behaviour: SQLite storage, a real HTTP stream, a real PTY. Keep one of each, not
one per test.

## Ledger

Keep a short ledger of what each stage removed and what guard it left behind. It
records coverage and gaps, not a score.

### Stage: test-suite audit (the campaign brief), 2026-11-20

- The suite was read end to end against its production code; every retained
  test names the break it catches. Deleted what did not earn its place,
  consolidated what covered the same break twice, and strengthened weak
  assertions in place rather than padding the count.
- Removed: the `contradicts`-edges storage test (duplicate of the
  storage-as-written guard — the same break through a second door; the
  no-cascade law stays covered by the deletion test); a tautological
  `total`/`sizes` assertion pair in the projection test (it re-derived the
  implementation definition; replaced with a nothing-is-omitted guard —
  all 50 ledger entries render in the frozen text); a dead `linked`
  fixture map and its no-op assertion in the project-tree symlink test; a
  duplicated `.brain` rejection in the live-session inspect test (the
  shared wall is guarded by "the boundary holds").
- Strengthened in place: `splitContextMessages` now asserts exclusive
  bucket attribution (an empty bucket reports zero, not a share of the
  rest) instead of "everything > 0".
- Housekeeping: the misleading "delete removes edges" title corrected to
  state the law (no cascade; edges stay as written); the CLI test helper's
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
  never-throws, ceiling-can-only-lower); the llama-swap provider's registry
  output; the headless driver end to end against the faux provider
  (chat-only person output, the no-chat parenthetical, /collapse, exit at
  stdin EOF); the capacity refresh lowering the live window after a turn;
  the CLI end to end with a scratch CARTO_HOME (--help, the missing-config
  one-liner, config creation, headless boot and clean EOF exit, an
  unsupported provider failing before any request). Known limits: nothing
  here proves a real llama-swap server answers — the person verifies.
  Still no test of a real provider, of wake tasks, or of a screen.
- As of R3 (2026-11-20): the live session runs against a faux pi-ai provider,
  end to end — a full tool turn with the pending list asserted by handle;
  the `onYield` continuation with the marker asserted present in the store
  and absent from the payload; `inspect` feeding `atlas` evidence digests;
  the `tree` tool moving the anchor; an agent-triggered collapse through the
  ceremony with stale-evidence marks riding the rebuild; a person-triggered
  collapse with no run in flight. Known limit: a tool-calling reply only
  enters a tool round with stopReason `toolUse` — the faux scripts set it,
  and real providers do the same. The ten-second budget is still unaddressed;
  the live-session tests are fast (faux, no waits) but nothing measures them.
- Still open: no test of a real provider, no integration coverage of wake
  tasks (deferred by §10a), nothing about a screen. R4 (config, llama-swap,
  the headless driver) brings its own.

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
  10 second budget. Four waits were responsible: a 1.25 second path-wake test, two
  `eventually` loops with 4 second ceilings, and a 50 millisecond sleep in the
  prefill monitor test.
- Outstanding: none of the above are fixed yet. The next stage that touches those
  tests must bring the run under budget or record the guard it drops.
