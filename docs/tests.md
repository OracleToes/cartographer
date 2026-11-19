# Tests

The test policy for Carto. It replaces the generic campaign brief this file
held before, which was written for an unknown repository and contradicted the
person on when tests run.

## The rule that comes first

**Tests run after the push.** A stage is: make every edit you expect the stage
to need, build until `tsc` and `npm run build` exit zero, commit, push, and only
then run the suite. Never between edits. When something fails, fix it, build,
push again, and test again.

This is not ceremony. A test run during a stage turns you into a machine that
watches a progress bar and calls it confidence. The build is the gate that lets
you say you are done; the tests are what catch you being wrong about that.

## Commands and budget

| Command | When | Budget |
| --- | --- | --- |
| `npx tsc --noEmit` | Before every push | Fast |
| `npm run build` | Before every push | Fast |
| `node --test test/*.test.mjs` | After every push | **10 seconds, hard** |

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
transcript, a script against a fake server, a one-off in `/tmp`. Run it after
the push, when you need it, and do not commit it.

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
| Frame | `renderFrame` is pure: same state in, same rows out, every row exactly the width |
| Input | The person's text is visible while typing, and the box never loses it |

Platform and integration boundaries are kept when they protect distinct
behaviour: SQLite storage, a real HTTP stream, a real PTY. Keep one of each, not
one per test.

## Ledger

Keep a short ledger of what each stage removed and what guard it left behind. It
records coverage and gaps, not a score.

### Stage: cleanup, 2026-11-16

- Deleted `docs/intent.md` (110 lines of unconfirmed inference) and rewrote this
  file for Carto.
- Measured before the policy took effect: the full run was 26 seconds, against a
  10 second budget. Four waits were responsible: a 1.25 second path-wake test, two
  `eventually` loops with 4 second ceilings, and a 50 millisecond sleep in the
  prefill monitor test.
- Outstanding: none of the above are fixed yet. The next stage that touches those
  tests must bring the run under budget or record the guard it drops.
