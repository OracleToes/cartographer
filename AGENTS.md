# Agent instructions

## Tests

`npm test` runs the whole suite through `test/all.mjs`, which holds a hard wall-clock budget: if everything
together takes longer than **10 seconds**, the suite fails. It runs:

- `test/unit.mjs` — fast unit tests: temp brain directories and direct calls to the operations. No model server,
  no terminal, no sandbox.
- `test/run.mjs` — integration tests that run the real `carto` command against a stand-in server
  (`test/stand-in.mjs`, not a model): the ledger, the plan, checkpoints, shell windows through bubblewrap, wakes,
  time, the atlas, the screen's pieces, two terminal (pty) cases and a launch through a symlink. Two (the terminal
  cases) are skipped without python3, and the two bubblewrap cases are skipped without it; both report as skipped
  rather than failing.

Rules for running it:

- Do not run the test suite while working a task, to check whether something works mid-step. It is for the end of a
  piece of work, before committing.
- Keep it under the budget. New tests must be deterministic and free of the real model server; a terminal (pty) or
  bubblewrap dependency is acceptable only if the test skips cleanly without them, and only if the whole suite still
  finishes inside 10 seconds.
- `test/all.mjs` enforces the budget mechanically; do not raise it to make a slow change pass. Make the slow test
  fast, or drop it with a note — do not enlarge the number.
- Every case must assert the specification the code is being held to now — read the code, then write the assertion.
  Do not carry forward a case that encodes a superseded behaviour without an explicit decision.

The former integration suite as it was (the full `test/run.mjs` with every case that survived on the old branch)
asserted an earlier specification and was several minutes long. The fast, spec-current subset has been ported and
rewritten where the spec moved; the rest was dropped deliberately. Anything from it that is re-added must pass the
same audit and the same 10-second budget.

## Git

- **Push proactively and atomically.** A commit is one coherent, named unit of work, and it is pushed the moment it
  exists — never left sitting in the local repository. The workspace can reset at any moment; only pushed work
  survives it. When in doubt, commit and push a small unit rather than carry changes in the working tree.
- **Push before testing.** Push each unit as soon as it is coherent, not after the suite has passed. Test after
  pushing; if a test then shows a problem, fix it and push the fix as another commit. Never leave the only copy of
  a change in the working tree while tests run or while a turn ends.
- **If the workshop resets, restore from the most recent commit.** Fetch, put the working tree back on the pushed
  state of `origin/<current branch>`, and carry on from there. Do not attempt to reconstruct lost uncommitted work.
- **Always push.** The user verifies and tests the work from the pushed branch, not from this workspace: a change
  that is not pushed does not exist for them. Every change lands on the current branch and is pushed to
  `origin/<current branch>` as part of finishing it — do not end a piece of work with commits only in the local
  repository.
- Push plain `git push origin <current branch>`; never force-push, never push to another branch, never rewrite
  pushed history.
- Commit in small, named units with messages that say what changed and why, as before.
