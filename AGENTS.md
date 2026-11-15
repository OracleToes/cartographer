# Agent instructions

## Tests

`npm test` runs `test/unit.mjs`, a fast unit suite with no model server, no terminal and no sandbox: temp brain
directories and direct calls to the operations. It finishes in seconds.

Rules for running it:

- Do not run the test suite while working a task, to check whether something works mid-step. It is for the end of a
  piece of work, before committing. (The former integration suite drove the real `carto` command against a stand-in
  server for five to six minutes per run; running it per step is what made tests a tax, and it is why they were
  hard-blocked.)
- Keep it fast. New tests must be unit-level, deterministic and free of the network, the model server, the terminal
  and bubblewrap. If a check needs any of those, it does not belong in this suite.
- Every case must assert the specification the code is being held to now — read the code, then write the assertion.
  Do not carry forward a case that encodes a superseded behaviour without an explicit decision.

The former integration suite (`test/run.mjs`, `test/stand-in.mjs`, `test/vt.py` on the main branch) asserted an
earlier specification and is not in this branch. It is not to be restored unless the user explicitly asks, and then
only after an audit of every case against the current specification and with a budget for its minutes. `npm test`
must never be pointed at it silently.
