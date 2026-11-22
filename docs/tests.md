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