# The rebuild, in slices

How §16 of `docs/intent.md` is being carried out. This file records the plan
that was originally proposed in conversation and lost; it was reconstructed
from the confirmed spec, agreed with the person on 2026-11-16, and is now the
reference for what each slice is.

Each slice is pushed and tested on its own. A slice is done when it is
pushed, and the suite runs green after the push (`docs/tests.md`).

## Done

**Slice 1 — the domain rebuild** (`888320c`, `e681d8d`). Explicit record
set: Atlas, Ledger, Chat, pins, wakes. Single-step delete, no pending state.
Generation-local handles. The projection machinery, and person-triggered
collapse: fresh generation, the prior store sealed read-only as the archive,
the older archive purged after one collapse of grace. Config drops
`collapseMode`. Suite ported and green.

## Slice 2 — the continuation loop

The state block and the per-request injection (§12, §12a, §12b, §19, §20,
§21). Confirmed scope, 2026-11-16:

- The projection is **frozen**: rendered once when a generation is created,
  persisted as a per-generation snapshot file under `.brain/context/`,
  immutable for the rest of the generation, deleted with it. Crashes reopen
  the identical bytes.
- Every request runs `beforeRequest`: state-block markers in the history are
  removed, and the freshly rendered block is appended as a trailing
  user-role message. After a text-only reply, `onYield` continues the run
  with a byte-sized marker message. The Pi store accumulates only markers;
  they die with the generation.
- The block carries the six approved contents: context fullness (last
  reported provider usage plus what has been added since), space by Brain
  part separately from tool work and stable system and tool prompts, one
  line per pending Brain write named by handle, what is stale named by
  handle, armed wakes and their target times, and the project tree.
  Nothing instructive.
- Its items reuse the Brain's handles. The pending list is ephemeral — it is
  a signal, not a record, and starts empty after a crash.
- The `tree` tool is **not** part of slice two; until slice three, the tree
  line shows the project root at a small fixed depth, Atlas-linked files
  marked.

## Slice 3 — the agent's tool surface

The dedicated `tree` tool (§26). The confirmed surface is chat, atlas,
ledger, pin, inspect, edit, shell, tree, sleep; audit the built set against
it (the agent currently has no `edit` and no `shell`). Wake exists but is
deferred by §26; keep-or-defer is the person's call when the slice starts.

## Slice 4 — archive recovery, for the person

Recovery opens the sealed archive read-only and copies chosen records back
into the Brain, restoring original types; evidence that no longer verifies is
marked stale. The agent gets no tool, command, or signal for any of this
(§29, §30).

## Slice 5 — the UI pass

Footer hints, copy, and the small taste items against the rebuilt action set.
Low stakes; defers to Posting when the UI layer is reached (this session's
standing rule).

## Open, independent of slice order

- Q7.2 — resolved 2026-11-16: the state block reuses the Brain's handles.
- Q8.x — the appetite/"small atomic edits" enforcement question.
- The archive mechanics (mtime discovery, one-collapse grace, chmod seal)
  remain an agent derivation, flagged in `MINI.md` and veto-able by the
  person at any time.
- Prompt iteration is ongoing by design (§22): minimal first, then tuned.
