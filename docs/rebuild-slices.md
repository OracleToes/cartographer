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

**Slice 2 — the continuation loop** (this commit). The state block and
the per-request injection (§12, §12a, §12b, §19, §20, §21), full confirmed
scope, with two repairs and one correction recorded here so they are not
mistaken for the spec:

- The projection is **frozen**: rendered once at generation creation,
  persisted as `<generation>.projection.md` plus `<generation>.projection.json`
  (the per-part token sums) under `.brain/context/`, atomic temp+rename,
  immutable for the rest of the generation, sealed 0o444 with the store at
  collapse, deleted with the generation at purge. A crash reopens the exact
  bytes (EnsureProjectionSnapshot re-renders only a missing file). The
  per-generation snapshot file is an agent derivation, flagged; so is the
  fixed tree depth and the `chat = ▤0` parts entry (Chat is never projected,
  §11 — its cost arrives as transcript/tool-work tokens).
- Every request runs `beforeRequest`: state-block markers in the history are
  removed, and the freshly rendered block is appended as a trailing
  user-role message. After a text-only reply, `onYield` continues the run
  with a byte-sized marker message. The Pi store accumulates only markers;
  they die with the generation.
- The block carries the six approved contents: context fullness (last
  reported provider usage plus an estimate of what has been added since —
  ▤ marks anything with an estimate in it, and a pure-provider reading
  carries no marker), space by Brain part separately from tool work and
  stable system and tool prompts, one line per pending Brain write named by
  handle, what is stale named by handle, armed wakes and their target
  times, and the project tree at the project root, depth 2, Atlas-linked
  files marked — a derivation until slice 3's `tree` tool owns the anchor.
- Space estimates: an assistant message carrying a tool call counts as tool
  work, as does every tool-result message; the remainder is transcript.
  Whole-message attribution keeps the two additive. The system message is
  estimated as the flattened prompt the model reads (content + sections +
  tools) from the request itself — no dependency on the previous provider
  payload for the headline numbers. The previous payload is used only for
  the since-last-report delta and still contains the injected block, a
  jitter of ~100 tokens.
- The pending list is ephemeral — a signal, not a record, empty after a
  crash — named by the Brain's handles.
- **Repair (sleep).** The `sleep` tool returned no run control, so §13a's
  "only a deliberate sleep stops the agent" was untrue: a text-only reply
  always continues (§6.2 mechanism), and sleep did nothing but append a
  tool result. `sleep` now returns `control: { terminate: true }`, which
  ends the run without another model request once the round is terminal
  (Pi Durable `ToolControl.terminate`). Verified by test.
- **Repair (tool-work visibility).** §21 demands tool work shown separately
  from the conversation and from the stable prompts; the estimate now
  splits tool work from transcript and reports both, and the fullness
  includes both.
- **Correction.** The context line claimed "▤" for everything; the marker
  now appears only when an estimate is involved (first request, or tokens
  added since the provider's own count).
- Not verifiable with the faux provider: `beforeProviderRequest` (and so the
  PromptStore recording and the provider-reported usage that feeds the
  fullness line) does not fire for faux models — it fires in every real
  provider API module (checked in pi-ai 1.5.2: openai-completions,
  openai-responses, anthropic-messages, google, bedrock, pi-messages,
  azure). The fullness line therefore reports pure estimates under the
  faux provider, by construction.
- The tree render excludes `.brain`, `.git`, and `node_modules`
  (derivation, flagged).

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

## The clean-slate rebuild, decided 2026-11-20

The person's order, in their words:

> "delete it all, if that means you have to re-do slice 1, then fine. you
> should have cleaned up the project instead of building on top of it, and
> then we wouldn't be dealing with this mess - or better yet, ask me what to
> do instead of assuming i wanted to preserve anything about the old version."

And, answering the scope question this turn:

> Scope: **everything in `src/` and `test/`, no exceptions** — including
> slice two (state block, tree) and the headless driver.
> llama-swap: **rewrite it fresh; "look at how the main branch does it for a
> decent solution"** — main documents keyless llama.cpp behind llama-swap,
> an OpenAI-compatible `/v1` endpoint, and per-model capacity advertised as
> `context_length` / `context_window` / legacy `meta.n_ctx`, discoverable only
> after the first routed request.
> legacy-import: **delete outright** — no rewrite.

The rule for the rebuild: nothing in the tree may predate the person's
confirmations or be inherited from the Mini/screen era. Everything is derived
from `MINI.md`, this file, and `docs/intent.md`. `MINI.md` is never edited by
the agent; amendments are the person's.

### Slices

- **R1 — the Brain.** Explicit records (Atlas with typed optional edges,
  Ledger with goals/notes/questions/instructions/progress, Chat, pins in both
  layers, wakes), single-step delete, generation-local handles, the Brain
  store (one document per project, `history: "latest"`, secure-delete, WAL,
  VACUUM on demand), `.brain` out of the agent's reach.
- **R2 — the projection and the collapse.** Frozen projection persisted per
  generation, stale-by-digest marking, person-triggered or agent-triggered
  collapse, fresh generation, the old store sealed read-only as the archive,
  one collapse of grace, purge that exports pinned-to-archive records first
  and only then deletes the store, Brain VACUUM.
- **R3 — the live session and the tools.** Pi Durable harness, the product
  tools (`chat`, `atlas`, `ledger`, `pin`, `inspect`, `edit`, `shell`,
  `tree`, `collapse`, `sleep`), the state block of `MINI.md` §6.1 injected
  per request as a trailing user-role message (`onYield` marker, stripped on
  every payload), collapse signalling per §5/§6.2.
- **R4 — config, llama-swap, the headless driver.** Global config,
  keyless llama-swap provider rewritten fresh (informed by main's documented
  approach), `--help`, and a placeholder headless stdin driver explicitly not
  the designed interface (§8 is the person's to mark).

Wakes: the Brain holds the records; the wake *tool* is the one deferred tool
(§10a), and the time/path wake runtime bounds are open (`docs/open-questions.md`
§11), so no wake runtime is rebuilt until the person settles them.

Not rebuilt and not deleted: `MINI.md`, `AGENTS.md`, `docs/`, `bin/`
(launcher), `package.json`/`tsconfig.json` (build scaffolding), `LICENSE`.
