# The rebuild, in slices

The plan for rebuilding Carto from `SPEC.md`. This file records what each slice
is and what is left of the plan.

Each slice is pushed and tested on its own. A slice is done when it is
pushed, and the suite runs green after the push (`docs/tests.md`).

## Done

**Slice 1 — the domain rebuild** (`888320c`, `e681d8d`). Explicit record
set as built: Atlas, Ledger, Chat, pins. Single-step delete, no pending state.
(Amended 2026-11-20: pins are markers on book entries, not a record kind —
see the R5 cleanup addendum.)
Generation-local handles. The projection machinery, and person-triggered
collapse: fresh generation, the previous generation's ephemeral material
swept to the archive, the old store deleted whole once the archive no longer
needs it. Config drops `collapseMode`. Suite ported and green.

**Slice 2 — the continuation loop.** The state block and the per-request
injection, with two repairs and one correction recorded here so they are not
mistaken for the spec:

- The projection is **frozen**: rendered once at generation creation,
  persisted as `<generation>.projection.md` plus `<generation>.projection.json`
  (the per-part token sums) under `.brain/context/`, atomic temp+rename,
  immutable for the rest of the generation, sealed 0o444 with the store at
  collapse, deleted with the generation at purge. A crash reopens the exact
  bytes (EnsureProjectionSnapshot re-renders only a missing file). The
  per-generation snapshot file is an agent derivation, flagged; so is the
  fixed tree depth and the `chat = ▤0` parts entry (Chat is never projected;
  its cost arrives as transcript/tool-work tokens).
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
  handle, what is stale named by handle, and the project tree at the project root, depth 2, Atlas-attached
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
- **Repair (sleep).** The `sleep` tool returned no run control, so "only a
  deliberate sleep stops the agent" was untrue: a text-only reply
  always continues (the marker mechanism, §5.7), and sleep did nothing but append a
  tool result. `sleep` now returns `control: { terminate: true }`, which
  ends the run without another model request once the round is terminal
  (Pi Durable `ToolControl.terminate`). Verified by test.
- **Repair (tool-work visibility).** The state block shows tool work separately
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

The `tree` tool and the rest of the surface as `SPEC.md` §7 lists it. Landed;
what is left in this slice is keeping the surface to that table and nothing
else.

## Slice 4 — archive recovery, for the person

Restoring is reached by the person's layer toggle and puts an entry back as its
original type (§3.3), and an attachment that no longer resolves comes back marked
stale. What is unbuilt is the view: the archive layer the toggle shows. The agent
gets no tool, command, or signal for any of this.

## Slice 5 — the UI pass

Footer hints, copy, and the small taste items against the rebuilt action set.
Low stakes; defers to Posting when the UI layer is reached (this session's
standing rule).

## Open, independent of slice order

- The archive layer's view (§3.3).
- Prompt iteration, ongoing by design: minimal first, then tuned.

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
from `SPEC.md`.
