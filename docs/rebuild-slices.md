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

**Atlas edges are stored as written, 2026-11-20.** The person ruled that
MINI.md §2.3 is to be applied to the letter: no existence validation on
edges at write time, and no cascade stripping edges when a node is
deleted. The graph is the agent's garden — a flood of unconnected nodes,
islands, and edges naming vanished nodes are the agent's to tend. The
tool boundary still resolves handles and errors on unknown ones (§6);
renderers must tolerate dangling edges.

## R2 landed, 2026-11-20 (`b2c5a44`, `d901f13`)

The frozen projection and the collapse ceremony exist and are tested.

- **Projection** (`domain/projection.ts`): structure, handles, state; no
  transcript copy, no Chat text; no context budget and no omission list —
  none was ever confirmed; every durable ID line carries an ISO 8601 UTC
  timestamp; dangling edges render as `(gone)`. Empty Brain renders
  `(the Brain is empty)`.
- **Freshness at rebuild** (`domain/freshness.ts`, `runtime/digest.ts`):
  digest drift on file-backed evidence marks stale; nothing blocks,
  nothing deletes; `context` sources verify by hand; paths resolve inside
  the root or not at all. Between collapses nothing is re-checked.
- **Snapshots** (`runtime/projection-files.ts`): one `.projection.md` +
  `.projection.json` per generation, written atomically, sealed `0o444`
  with the store at collapse, deleted at purge; a crash reopens identical
  bytes.
- **Collapse** (`runtime/collapse.ts`): freshness marks → frozen snapshot
  for the new generation → seal the old store read-only → one collapse of
  grace on the previous archive → exports **then** delete → Brain
  `wal_checkpoint(TRUNCATE)` + `VACUUM`. Open-time reconciliation: a head
  generation missing its snapshot is deleted (the Brain builds the next
  one); anything beyond live + one archive is purged the same way; the
  live store is unsealed if a crash sealed it.
- **Known seam, not filled:** the pinned-to-archive export. Nothing can
  be pinned to the archive until the recovery tooling defines the marker
  shape; the code path already exports before deleting (test-spied), and
  filling it invents an unconfirmed format. Open question for the person
  below.

Not done: R3 (tools, live session, state block), R4 (config, llama-swap,
driver). The collapse exists but nothing triggers it yet; the live session
wires the trigger in R3.
## R3 landed, 2026-11-20 (`755f1c7` and the R3c commits)

The live session and the tools exist and are wired end to end.

- **Tools** (`runtime/tools.ts`): `chat`, `atlas`, `ledger`, `pin`, `inspect`,
  `edit`, `shell`, `tree`, `collapse`, `sleep` — the confirmed §10a surface,
  nothing more (`wake` stays the deferred tool). pi-schema validators;
  handles are the only record references; unknown handles are explicit
  errors at the call site. Atlas evidence is verified against the file's
  current digest. The agent removes carry pins only; the person's pins are
  theirs. The boundary: every path resolves inside the project root, a
  symlink that escapes is rejected, `.brain` is untouchable by Carto tools.
- **Live session** (`runtime/live-session.ts`, `runtime/carto-extension.ts`):
  Pi Durable harness, one store per generation under `.brain/context/`,
  reconciled at open; the frozen projection rides as a byte-stable
  untagged section; a fresh snapshot is written from the Brain when no live
  generation exists. `beforeRequest` strips markers and appends the fresh
  state block as the trailing user-role message; `onYield` continues a
  text-only reply with the byte-sized `<carto-state/>` marker;
  `afterResponse` folds the provider's input count; Pi compaction is declined
  (a declined compaction asks for a collapse instead). Collapse is signalled
  by the `collapse` tool (`control.terminate`) or by the person at any time;
  `collapseLiveSession` interrupts at the boundary, runs the ceremony, and
  reopens on the new generation.
- **The block** is rendered from the Brain and the session, never persisted:
  context fullness (last provider report + tool work since), space by Brain
  part, one line per pending write named by handle (ephemeral, cleared at
  collapse), stale evidence named by handle, armed wakes, the tree anchored
  where the agent's attention is with Atlas-linked files marked.
- **Fixed in passing:** the collapse ceremony now creates the new generation's
  store (empty, valid) at snapshot time — without it an open-time reconcile
  would treat the frozen-but-storeless generation as a crash remainder and
  delete it, or adopt the sealed archive as live. Found wiring R3c; R2's
  invariants were verified before touching it.
- **Reconciliations a person should see:**
  - §6.2 names `beforeProviderRequest` as the injection hook. Injection happens
    at `beforeRequest` instead: the payload is pi-ai's provider-native format,
    and a payload-level splice would reimplement provider specifics §11
    forbids, for the same wire result. The model sees one block at the tail;
    the store keeps only markers; both were verified in the tests.
  - Tool-calling replies only enter a tool round with stopReason `toolUse`;
    the faux provider scripts set it, as real providers do.
- **Known seam, still open:** the pinned-to-archive export (unchanged from R2);
  the marker shape for it is a question for the recovery tooling.
- **Owed to R5:** the person-facing transcript must hide marker messages
  (`isMarkerMessage` is exported for exactly this); the store legitimately
  contains them between collapses.

## R4 landed, 2026-11-20 (this branch)

The last slice before the interface: the global config, the keyless
llama-swap provider rewritten fresh, advertised-capacity discovery, and the
placeholder headless driver.

- **Global config** (`runtime/config.ts`, `runtime/paths.ts`): one file,
  `~/.carto/config.json` (`CARTO_HOME` overrides the directory). `version: 1`,
  `model` as `provider/modelId` (split on the first slash — llama-swap model
  ids contain slashes), optional `llamaSwapEndpoint` and `contextWindow`.
  Missing file + `--model` creates it; missing file without it fails with the
  one-liner that creates it. Overrides against an existing file apply in
  memory only; the file is rewritten only at creation.
- **The llama-swap provider** (`runtime/llama-swap-model.ts`), rewritten
  fresh, informed by main's documented approach only: keyless (Pi's client
  needs a non-empty internal value; `authorization: null` drops the header),
  OpenAI-compatible `/v1`, openAI-completions API, `max_tokens` field, no
  developer role / reasoning_effort / store / streamed usage. GBNF
  enforcement, `/consult` probes, and the prefill machinery were **not**
  brought over. Other providers fail plainly: this build wires llama-swap
  only.
- **Advertised capacity** (`runtime/capacity.ts`): llama-swap knows a model's
  true capacity only once it has loaded. Discovery GETs `{endpoint}/models`
  and reads, in order, top-level `context_length`, then `context_window`,
  then legacy `meta.n_ctx`, strict-matched on the model id (a capacity from
  another route is never applied). It never throws — any failure leaves the
  configured ceiling standing. The active window is
  `min(configured ceiling, advertised)`: discovery can lower, never raise;
  raising the ceiling is the person's act, by editing config. The headless
  driver re-discovers after every settled run and adjusts the session's
  context window (the state block's fullness report) at that point, with a
  plain line saying so.
- **The headless driver** (`runtime/headless.ts`), explicitly a placeholder —
  §8 is the person's to mark. A line-based stdin/stdout loop; person-facing
  output is only the agent's `chat` tool words (`carto: …`), never plain
  model text; a turn without a chat call prints `(no chat message)`.
  `/collapse` runs the ceremony on the spot and prints the plain report;
  `/quit` ends. The agent's own collapse request is honoured the same way.
- **CLI** (`src/cli.ts`): real `--help`; `--model`, `--endpoint`,
  `--context-window`, `--root`; without config it exits 1 with the one-liner.
  `scripts/install-home.mjs` now names ByteShape in its epilogue.
- **Reconciliations:**
  - The provider's `contextWindow` travels through session state
    (`LiveSessionState.contextWindow`, mutable) so a mid-session discovery
    can adjust the block's fullness figure without reopening the generation.
    `session.contextWindow` reports the open-time value.
  - Capacity matching is strict on the model id; the tempting
    single-route fallback was rejected (it would apply another route's
    capacity on a typo) — recorded here so the decision is visible.
- **Known limits:** untested against a real llama-swap server (the person
  verifies — endpoint, ByteShape id, and the 75000 ceiling are theirs);
  the configured ceiling is a ceiling (discovery never raises it); pre-flight
  discovery at session start will usually find nothing until the model has
  loaded once.

### Addendum — the person's answers, 2026-11-20 (same day)

- **Per-mechanism review (Q1.1).** Elegance is decided mechanism by
  mechanism: each mechanism must justify itself in review, or it is flagged
  for removal. Decided in conversation, binds future work.
- **Novelty (Q1.2).** Novelty is a description, not a requirement. Conventional
  is fine when it works; unfamiliar must be useful, and is not demanded.
- **`beforeRequest` ratified (Q7.0 naming).** The spec's hook name
  `beforeProviderRequest` stays overridden: injection happens at
  `beforeRequest`, for the same wire result, without reimplementing
  provider specifics. The person kept it after the trade was shown.
- **Token bar (§9): ship a live bar anyway.** The person chose this after
  being shown that main's `prompt_progress` shape was never verified and
  may be invented. Agreed consequence, recorded verbatim: the live segment
  of the bar may show nothing on the real server; the exact post-request
  numbers (payload + provider usage) remain the truthful fallback, and the
  bar must never display an invented figure as if it were measured.
- **The headless driver could not take input.** The person ran R4 and got
  the banner and silence — stdin at EOF (not a terminal) ends the loop
  silently. Fixed: readline runs in terminal mode when stdin is a TTY, and
  a non-terminal stdin that carried no lines announces itself on the error
  stream instead of exiting without a word. Verified under a pty and with
  stdin from /dev/null. 70/70.
- **The shell tool's bounded rules were never discussed with the person.**
  They are not spec: no timeout clamp, no output tail cap, no exec buffer
  ceiling, no kill-on-timeout may be assumed as approved. Presented to the
  person verbatim; disposition pending their answer. Related and open:
  the `shell` tool bypasses the ".brain is not yours" line that `inspect`
  and `edit` enforce (a command like `cat .brain/brain.sqlite` runs); the
  spec line is the person's, the bypass decide is also pending.

Not done: R5+ (the interface, when the person settles §8's marks).
### R4 addendum II — the shell call and the dependency-first audit, 2026-11-20

**The shell, by the person's call: pi's built-in bash tool ("C").** The
invented bounds (timeout clamp, SIGKILL, 30k tail, 8 MB buffer,
`runShell` on pi `exec`) are gone with the tool itself. `NodeExecutionEnv`
is wired per conversation (`Harness.env`, cwd = project root); the tool is
`createBashTool()` from `@earendil-works/pi-durable/tools`. No limits of
ours remain; pi keeps its designed 2000-line / 50 KB tail and spills the
full output to a temp file reported as a diagnostic; the model may pass a
timeout in seconds; interrupting the run kills the command (tested:
a run interrupted during `sleep 30` settles promptly, no orphan).
MINI.md §10a names the tool `shell`; the shipped name is `bash` — the
person's explicit pick. MINI.md itself is never edited; this entry is the
reconciliation. The system-prompt `.brain` line now states only the truth:
the archive is the person's alone to restore from. inspect/edit are our
tools (not harness-native); their wall stays. The suite covers the bash
tool through the environment end to end (74/74).

**The dependency-first audit the person ordered** ("make sure we're not
hand-rolling anything else that pi-durable or pi-ai already does, especially
what you've already written into this project"). Findings, all verified
against the installed packages, none resolved by fiat:

- `runtime/capacity.ts` (the /v1/models probe) — **hand-rolled provider
  behavior; fixed this turn.** Pi-ai has the designed machinery:
  `Provider.refreshModels` via `createProvider({ fetchModels })`, driven by
  `Models.refresh({ providers })`. The llama-swap provider now maps the
  listing onto Model objects (`context_length` → `context_window` → legacy
  `meta.n_ctx`, strict id, `min(ceiling, advertised)`), the driver refreshes
  before open and after every settled run, failures are silent and
  retain-on-failure by pi's design. `capacity.ts` is deleted. One
  unreachable-server test of mine hung the suite on outbound connect
  semantics; it was removed and replaced with an in-process stub test plus a
  real-socket test against a local mock llama-swap. Deterministic, no
  network-behavior reliance.
- `runtime/brain-store.ts` — **hand-rolled SQLite adapter
  (`node:sqlite`).** §11 keeps SQLite adapters off our plate; but pi's
  stores are commit/append-oriented and the Brain's confirmed semantics
  (current state only, one-row one-document overwrite, single-step delete,
  "delete means delete") are not what they model, and the Brain is separate
  from Pi storage by the person's own §4.2 confirmation. Kept, flagged.
  Per-mechanism review (Q1.1) applies; the person can order it redesigned
  onto pi's document machinery. **Superseded by addendum III below.**
- `runtime/tools.ts` `inspect`/`edit` vs pi's `createReadTool`/
  `createEditTool` — **reviewed and kept.** Pi's read has no `.brain`
  wall, no bounded lines (400), no digest; pi's edit has no
  unique-occurrence guarantee, no atomic create-with-empty-oldText, no
  `.brain` wall. Both are product-surface semantics the spec demands;
  wrapping pi's would be full reimplementation anyway.
- Everything else checked clean: harness/conversation/tasks/LiveDoc/`waitForTask`
  (interrupt), tools via `defineTool` + pi-schema validators, extension pieces
  (`section`, `hook`, `defineExtension`, `CompactionTask`, `GenerationTask`),
  `SqliteStorage` and `openNodeSqliteDatabase` (used, not reimplemented),
  the collapse ceremony's primitives, pi-schema arg validation, pi-ai faux
  provider in tests, Node builtins only where Pi has no opinion
  (`parseArgs`, `readline` for the headless placeholder, `path`/`fs`/`os`,
  `crypto` for digests).
- Not pi's job by design: our projection/handles/freshness/state-block
  machinery, the tree renderer, config files, the installer, the CLI shim.
  pi-tui is unused so far (nothing renders yet).

Known seam carried forward unchanged: §6.2's `beforeProviderRequest` vs the
shipped `beforeRequest` (person kept it), the pinned-to-archive export
(person), the `.brain` archive line (person's answer: the shell needed
nothing special; inspect/edit keep the wall).

### R4 addendum III — brain-store rebuilt on pi's SQLite machinery, 2026-11-20

The person reversed the "kept, flagged" call in so many words: if pi is
already doing it, tear it out and rebuild it, and stop asking for
confirmation of settled decisions. Finding first, then the rebuild.

**pi does not already do it.** pi-durable's session singleton documents
(`defineDoc({ scope: "session" })`) nearly match one row per project, but
every commit stores the change — as a delta from a base, or as a complete
base when `checkpointWhen` says so — and old incarnations are retained
forever; `retireDoc` stamps `retiredAt`, it is a tombstone, and no
document-layer operation deletes stored history. The Brain's confirmed
semantics (current state only, single-step delete, no audit trail) are
the opposite of that model, and §4.2 keeps the Brain out of Pi storage
regardless. chord's `store` (tables stamped with commit seqs, an outbox,
row history, archives) is Durable's commit substrate — same story one
layer down, with a claims/migration protocol far beyond a one-document
Brain. Using either would bury the Brain's "delete means delete" under
history it must not keep.

**pi does already do the layer that was hand-rolled.** chord's
`sqlite/node` facade — `openNodeSqliteDatabase`, the same one pi-durable's
own adapters sit on — is node:sqlite with WAL, synchronous=NORMAL, a
5,000 ms busy timeout, `BEGIN IMMEDIATE` transactions with
rollback-with-same-error, a prepared-statement cache, and a WAL
checkpoint(TRUNCATE) at close. That is exactly what the hand-rolled
adapter reimplemented inline. The Brain store is now built on it: same
one-row, one-document overwrite, same decode-or-throw, same
`secure_delete` pragma (asked for on open, pi does not set it), same
`VACUUM` at `compact()`, plus the facade's checkpointing `close()`.
`history: "latest"` remains by construction: one row, overwritten in
place, no audit trail — now on pi's SQLite, not on `node:sqlite` directly.

**Cost:** every store operation is now async. `BrainStore.read/apply/
compact/close` and `openBrain` return promises; call sites in
`collapse.ts`, `carto-extension.ts`, `tools.ts`, `live-session.ts`,
`headless.ts` (`drainAgentChat`), `cli.ts`, and the tests follow. The
Brain's file stays `.brain/brain.sqlite`, separate from the Pi store.
