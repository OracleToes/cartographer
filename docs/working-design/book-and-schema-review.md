# Review: the universal `book` tool and the on-demand schema lifecycle

**Status:** review complete; **Phase 1 of §6.10 is implemented** on this branch (the replay lifecycle and the legacy interface are gone; the flat declaration and the CAPABILITIES table are in; `fold`/`note`/`collapse` are first-class `context` actions again). Phases 2–5 are not started. No tests were run (they are disabled in this workspace, and the live endpoint remains unverified); verification is `node --check`, module import and offline validation probes (Appendix D). Measurements are local estimates, taken with `charsPerToken: 4` unless marked otherwise.

**Branch:** `arena/ea0e570a-cartographer`, branched from `0e566c0b4787399ba7be4be99090724492905228`, whose single commit already contains everything described here (the schema-compaction work and the universal-book work landed together, and the test suite was deleted in the same commit).

---

## 1. The short version

The problem is not that the full schema is big. It is that the design answers "the provider cannot carry this schema" by making the conversation *do the routing*, and it does so without telling the model or the user that this is happening. What shipped is:

1. the provider told, in the tool declaration, that `book` takes a `target` (enum) and an optional `action` (enum) and nothing else of substance;
2. a model that emits the natural, complete call (`{"target":"plan","action":"add","operation":{...}}`) has its call **silently swallowed** — erased from the assistant message before a tool round starts, so nothing validates or executes it;
3. the run continues only through an invisible continuation and a **hidden second request** carrying a 2–11k-token "schema" as a message *from the user*, asking the model to reissue the call;
4. a reissued call is checked by three mutually disagreeing validators, and a model that cannot guess the undocumented `operation: {...}` envelope fails anyway.

Each of those steps is defensible in isolation and observable in the code; together they make book calls unreliable in exactly the deployments this harness targets (llama.cpp + small Qwen-class models). The book tool additionally carries two parallel interfaces (legacy `book`/`ops` and `target`/`action`) and a schema-*generation* engine whose only purpose is to feed step 3.

The refactor below deletes the ceremony and the generator, keeps the confirmed `target` + `action` contract and the Stage 4 identity catalog (which is sound), and moves all per-branch complexity into local validation — which is where it already lives and where it can give good error messages. Net effect is roughly **−1,100 to −1,400 lines** (~500 from book.mjs, 335 from the deleted lifecycle module, plus the wiring), one model round-trip per call, and a tool that works on the first try or fails with an actionable message.

---

## 2. What exists today

### 2.1 Shipped in this commit

| Area | Files | Lines | State |
|---|---|---|---|
| Universal `book` tool | `src/tools/book.mjs` | 1,273 | Legacy + universal interfaces; dispatch, validation, 16 targets |
| Schema lifecycle | `src/tool-schemas.mjs` | 335 | Created in this commit; wired in `harness.mjs`, `request.mjs` |
| Identity catalog | `src/catalog.mjs` | 353 | Files, namespace, versions, fork journal; largely sound |
| Shared row engines | `src/rows.mjs`, `src/ops.mjs`, `src/books.mjs` | ~400 | Shared ledger/books/row machinery; good |
| Context/shelf engine | `src/context.mjs` | 1,277 | Shelf with backing snapshots, reports, curated/composed rows, collapse |
| Deleted | `src/tools/{ledger,plan,books,assess,context,prompt}.mjs` | ~900 | Folded into `book` |
| Deleted | `test/run.mjs` (5,651), `test/stand-in.mjs` (414), `test/vt.py` (131) | 6,196 | In `cea8468` only (see §9) |

### 2.2 Measured sizes

Built with the real `bookTool()` factory and the real `createToolSchemaLifecycle()`:

| Artifact | Bytes | ~Tokens (chars/4) |
|---|---|---|
| `book` **validation schema** (allOf + if/then/not; never sent to the provider — stored on the tool object and used for local validation) | 15,210 | 3,803 |
| `book.description` | 1,264 chars | ~316 |
| Provider declaration swapped in at send time (`BOOK_COMPACT_PARAMETERS`) | **551** | ~140 |
| Universal `book` call stored in history, typical | 200–600 | ~50–150 |

Per-target trees injected as "schema context" — `bookTargetParameters(source, target)` then `strictSchema()` (optional fields become `anyOf: [x, null]`, every property required):

| Target | contextText chars (pretty-printed) | ~Tokens | strict bytes |
|---|---|---|---|
| file | 16,762 | 4,199 | 9,254 |
| report | 13,611 | 3,411 | 7,360 |
| ledger | 24,344 | 6,094 | 12,725 |
| **plan** | **43,553** | **10,897** | 22,015 |
| **atlas** | **43,585** | **10,905** | 22,559 |
| assessment | 23,483 | 5,879 | 12,091 |
| practice | 23,429 | 5,866 | 12,039 |
| context | 31,896 | 7,982 | 15,469 |
| conversation / message / toolCall / toolResult / prompt / tool / schema | 5,435–7,976 | 1,367–2,002 | 2,900–4,300 |
| shelf | 12,455 | 3,122 | 6,809 |
| **Sum of all 16 target trees** | **132,964** | **~33,241** | — |

Fixed prompt cost for comparison: system prompt 7,606 chars (~1,900 tokens); all 14 tool descriptions together 5,420 chars (~1,355).

### 2.3 Budget reality check

`schemaBudgetTokens = floor(contextWindow × POLICY.limits.toolSchemas.contextShare)` with `contextShare = 0.15` (`src/config.mjs`, `src/harness.mjs:247`):

- `contextWindow = 100,000` → budget 15,000 tokens. `plan` and `atlas` trees fit (~10,900), everything else fits.
- `contextWindow = 64,000` → budget 9,600 tokens. **`plan`, `atlas`, `context` branch schemas are all refused at `loadBookBranch`** ("above the schema budget; no operation was enabled"), so `book plan …` / `book atlas …` cannot run at all on a 64k server.
- `contextWindow = 32,000` → budget 4,800 tokens. Only `file`, `report`, `conversation/message/toolCall/toolResult/prompt/tool/schema`, `shelf` remain callable.

The budget is measured with the chars/4 estimator, not the server's tokenizer, and the injected schema message is then counted as ordinary "work" tokens in the collapse accounting (`messageTokens`), not reserved against schema headroom. The 4A contract ("reserve and account for schema headroom", "collapse-before-overflow is not yet a guarantee") is therefore **not implemented**, and the current trigger (`engine.afterMainCall`, 80% full at `src/engine.mjs:72,242` (`collapseFull = 80`, `src/config.mjs:94`)) can fire only *after* a too-large request has already been rejected by the server.

---

## 3. How a book call behaves today (mechanism trace)

Verified against the installed `pi-durable@1.5.2` (`node_modules/@earendil-works/pi-durable/dist/harness/generation.js`, `harness/tool.js`).

### 3.0 The interception rule (applies before any of the paths)

Every `book` tool call whose `target` is a known branch is intercepted in `afterResponse` — **before the tool round exists** (`src/tool-schemas.mjs:159`). `interceptBookRouting` clones the call into `originalCall`, calls `loadBookBranch` (which builds the strict schema tree and enforces the token budget, or refuses it), then **erases the message's content** (`message.content = []`), stamps a `cartographer_book_schema_replay` diagnostic onto the emptied assistant message, and returns without starting a tool round. `mustRoute` (`src/tool-schemas.mjs:164`) is true whenever no replay is pending for that branch — which is always, on the first send. So:

- The model's first `book` call of any shape is **never executed on that send** and never appears in a tool round. There is no cold-start one-round book call.
- The stored transcript gains an empty assistant message plus the marker; the run continues only because `onYield` sees `hasReplay` and appends one invisible `\u2063` user message (`src/harness.mjs:371`).
- The next request re-injects the selected branch schema as a **user message** (`forRequest`, `src/tool-schemas.mjs:330`), and the model is expected to reissue the call.

The routing probe itself is `{"target":"plan"}` and nothing else: `isBookBranchRequest` (`src/tool-schemas.mjs:100`) requires `Object.keys(args).length === 1`. Nothing in the description, the schema, the system prompt, or the state block ever tells the model that this shape — or the hidden round trip — exists.

### 3.1 Path A — the natural, complete call (most common shape; also cannot execute on first send)

`{"target":"plan","action":"add","operation":{…}}` on a cold conversation:

1. `afterResponse` → `interceptBookRouting` (candidate: any `book` call with a known branch target; `mustRoute` true). `loadBookBranch` builds ~10.9k tokens of pretty-printed strict JSON for `plan` (or refuses the branch if it is over budget).
2. The message is emptied and stored; `replays.set(conversationId, route)`; the tool round never happens — nothing validates or executes the full call, server-side or locally.
3. `onYield` → `hasReplay` → `{ continue: "\u2063" }` appended as a user message (counted as a reply in the harness's stretch counter and in `mainTurns`/`taskTurns`).
4. Next request: marker stripped, the `\u2063` message dropped, the schema injected as a user message (see Path B).
5. The model reissues; this time `afterResponse` ignores it (the selection exists for that branch) and `beforeTool` passes or blocks it; it executes or fails locally.

Net effect: **two model invocations minimum, ~10.9k tokens of schema user-message, one stored empty assistant entry, per book call** — with nothing anywhere telling the model that this is the expected dance. The beforeTool message "could not be routed" (which an earlier draft of this section blamed for cold-start calls) is real but secondary: it only fires when a full call reaches the tool round with no pending selection — e.g. after the 3-attempt apology path, a target outside `BOOK_BRANCHES`, or a nested call outside the orchestrator.

### 3.2 Path B — the one-document accepted shape, `{"target":"plan"}`

Identical flow, with `originalCall = {"target":"plan"}`. The reissue that follows is guided only by the injected text:

> `Available parameters for the book tool (target: plan):\n<43 KB of pretty-printed strict JSON>\n\nCurrent requested book call: {"target":"plan"}. Reissue this call using the schema above, preserving its intent and including all required arguments.`

Restart recovery (the one genuinely careful part — `forRequest`, `src/tool-schemas.mjs:271-306`): selection is rebuilt from the stored diagnostics marker plus the retained schema version (`readReferenceVersion`), and the same injection happens. It is also **untested** — no test in the deleted suite exercised routing at all — and it depends on the retained version surviving, which `loadBookBranch` writes unconditionally on every route. The `routeResults` recovery path is dead code: no `toolResult` with `schemaSelection.phase === "branch-route"` can ever exist, because interception happens before any tool round.

Consequences that remain in force for both paths:

1. The injected text is a plain `role: "user"` message; the stored transcript grows by ~2,300–11,000 tokens per episode; the Context tab labels it **"Chat · You"** (nothing tags it as Cartographer's — `partsOfMessage` in `src/screen/views.mjs` assigns `cat: "you"`), i.e. the user appears to have pasted 11k tokens of schema JSON. It is also counted as ordinary `work` tokens, spending the collapse budget.
2. `dressRequest` runs this filtering **on every request** over the whole stored history (`flatMap` over all messages, plus scans for markers and probes — `src/tool-schemas.mjs:271-332`): O(history) machinery to maintain junk that accumulates twice per operation.
3. The marker remains in storage forever (stripped from dressing, never from the store).
4. On operation failure the branch state is retained (correct), but the model is re-fed the same dump with no diff, no attempt count, and no indication that the same call already failed. `replayAttempts` increments only on bare-target intercepts; a model that keeps emitting full-but-invalid calls never reaches the `attempts >= 3` apology (`src/tool-schemas.mjs:167`) and has the schema re-injected **before every request indefinitely** (in practice bounded only by `loopCheck`, which is disabled for bare branch calls and applies normally to full calls — repeated identical full calls end in `LOOP_STOP`, but varied invalid calls fail without limit). When the apology does fire, the user sees an unexplained plain-text refusal ("I couldn't complete the book.… operation from its schema. Please clarify the action you want.") that matches none of the Harness's loop/limit messaging.

### 3.3 Path C — the reissued call inside a pending replay (the only executing path)

`afterResponse` returns false for calls in the pending branch, so the call reaches the tool round: `beforeTool` requires `pending[branch] === arguments.target` and `matchesSchema(...)`, then rewrites strict-mode null sentinels and hands off. If it mismatches, `afterTool` marks `selection.failed = true` and **keeps the selection**, so every later request re-injects the schema. The undocumented `operation: {...}` envelope makes mismatches common in practice (see H3).

### 3.4 Path D — nested/direct invocation

The `isBookBranchRequest` branch of `normalizeTool.execute` (`src/tool-schemas.mjs:215`) is nearly dead in the model-driven flow (interception happens first) and mirrors Path B. Dead code that adds a second reference to the live path.

### 3.5 What is stored per routing episode

- one assistant entry with `content: []`, `stopReason: "stop"`, and a `cartographer_book_schema_replay` diagnostic (permanent junk, stripped from dressing on every request forever);
- one `user` entry `\u2063` (same);
- zero tool results for the route;
- the retained schema version under `.atlas/catalog/entities/` (written unconditionally by `loadBookBranch`);
- optionally, a full sub-conversation if the target dispatches to a `task` focus (orchestrator file/report/durable reads and file mutations — see §4 H6).

### 3.6 The validation story is three (or five) schemas deep

For one call, these all run, and they can disagree:

1. **Provider-visible declaration** — `BOOK_COMPACT_PARAMETERS` (target enum + flattened action enum, `additionalProperties: true`, only `target` required; swapped in at send time by `beforeProviderRequest`, `src/tool-schemas.mjs:226`). No per-branch fields exist here at all; the undocumented `operation` envelope is invisible. On any model whose `api` is not `openai-completions`, `beforeProviderRequest` **throws** — no book operation, and indeed no request at all, can be sent.
2. **`cleanNullableArgs` + `matchesSchema`** (`src/tool-schemas.mjs:59-132`) — hand-rolled structural matcher used to strip strict-mode null sentinels and to refuse mismatched calls in `beforeTool`.
3. **`prepareArguments`** — `compile(validationSchema)` where `validationSchema` carries `allOf: BOOK_CONDITIONS` with `if/then/not` (good error text, but rejected by provider strict mode, and error paths special-cased by hand — e.g. the `hasRootPlanText` `not`-failure rewrite, `src/tools/book.mjs:~1237`).
4. (Legacy interface only) the same `BOOK_CONDITIONS` via `union()`-built `LEDGER_OP`/`PLAN_OP`/`BOOKS_OP`/`CONTEXT_OP` — a **second, duplicate** encoding of the per-branch grammar, used only by the legacy path and the projection engine. These unions are *not* used for execution (execution uses the hand-written `rows.mjs`/`atlas.mjs` spec engines).
5. (Projection only) `bookBranchParameters`/`bookTargetParameters` — schema **surgery** on the library-built schema: cloning, deleting keys, deleting `allOf`, re-adding `null` sentinels, specializing `ledger.add` by `kind` and `plan.add/edit` by `mode`, rewriting `ref`'s `kind` to a const. Every projection throws unless the `allOf` looks exactly like what it expects (`book.mjs:971-1089`), and `specializeOperation` (`book.mjs:1107`) silently rewrites `exactlyOne` structures. This is the most brittle code in the repository.

The two hand-written worlds (pi-schema unions ↔ `rows.mjs` spec hooks) already drift: `ledger.add` requires `done_when` for goals in both, but `BOOKS_OP`/`CONTEXT_OP` contain variants the executors do not (e.g. context `shelve`/`unshelve`/`fold`/`note`/`collapse` exist only in the legacy union, not in the universal matrix — see H4).

---

## 4. Findings

Severity: **C**ritical (tool unusable/misleading in the default configuration) · **H**igh (data, context, or budget integrity) · **M**edium · **L**ow.

### C1 — Every first book call is swallowed; the accepted call shape is unguessable
The natural thing a model does — emit one complete, valid call — is erased in `afterResponse` before it can execute: the message is emptied, a tool round never starts, and the run continues only via the invisible `\u2063` continuation and a hidden second request carrying ~10.9k tokens of schema as a fake user message (§3.1). The protocol that *would* minimize this (emit a bare `{"target":…}`) is documented nowhere the model can see — not in the description, not in the schema, not in the errors, not in the state block. The observable outcomes are: hidden round trips, mid-context window burns, stored marker junk, or a model that never figures out the dance and ends turns without doing work. This alone satisfies "the tool calling schema is broken."

### C2 — `plan` and `atlas` are uncallable at ≤64k windows; barely callable at 100k
`loadBookBranch` refuses any branch whose pretty-printed strict tree exceeds `contextShare × contextWindow`; `plan` is ~10.9k tokens (43.5 KB), `atlas` ~10.9k, `context` ~8k. On a 64k server these targets are dead; on 100k they fit only because 10.9k < 15k — with zero headroom for a long `operation` payload. The measure uses the chars/4 estimator, and nothing is actually *reserved* against collapse headroom.

### H1 — Cartographer's schema dump is stored and rendered as the user's message
The injected `Available parameters …` text is a plain `role: "user"` message; the stored transcript grows by ~2,300–11,000 tokens per episode; the Context tab labels it "Chat · You"; it is re-injected after every failed operation and is counted as `work` against the collapse trigger. `dressRequest` re-derives this on every request by scanning the whole store.

### H2 — Stored junk and O(history) dressing scans
Each episode stores an empty assistant entry + a `\u2063` user entry forever (markers stripped in dressing, never in storage). `forRequest` walks every message on every request. Restart recovery depends on these markers and on a schema version being retained from an earlier route — a fragile side channel running through stored bytes.

### H3 — The undocumented `operation` envelope makes brain mutations unguessable
Neither the provider declaration nor the description mentions that brain mutations nest their fields in `operation`. Passing them at top level fails validation ("needs an operation payload"); passing them in `operation` without `expectedVersion`/`ref` fails again. Only error-message trial and error teaches the shape — and the failure modes are exactly §3.2/§3.6.

### H4 — Universal interface cannot express fold / note / collapse; the prompt mandates calling them anyway
`UNIVERSAL_ACTIONS` (`book.mjs:27`) and `BOOK_BRANCH_ACTIONS.context` (`book.mjs:939-955`) omit `fold`, `note`, `collapse`, `shelve`/`unshelve`. Yet the system prompt instructs the model to use exactly those operations — `src/prompt.mjs:56` ("With `book`'s context operations you act yourself: `fold` a report once you have done its bookkeeping … `shelve` a file … or `collapse` now"), `src/prompt.mjs:223` ("`book` with book context, action note") and `src/prompt.mjs:240` ("put a file you keep needing on your shelf with `book`'s context operations"); the tool description itself implies brain verbs are intact ("atlas/ledger/plan/books/context keep their established verbs", `src/prompt.mjs:17`), while the stale `context` catalog entry (`src/prompt.mjs:27`) advertises `archive, unarchive and delete … `fold` … `shelve` … `collapse` directly. The only functional path to fold/note/collapse is the legacy `book: "context", ops: […]` form, which the description frames as deprecated compatibility ("Old `{book,ops}` calls are one-operation compatibility only; prefer target/action"). Consequences: the agent cannot fold a large report, cannot keep a task note, and cannot ask for its own collapse — three controls the collapse/keep engine fundamentally relies on (`runContext` in `book.mjs:665-850` still implements them, reachable only via legacy calls with a shape nothing documents for the universal target).

### H5 — Three sources of truth for the per-branch grammar, already drifting
See §3.6. The pi-schema unions are used for legacy validation and projection; execution uses `rows.mjs`/`atlas.mjs` hooks; the provider sees a 600-byte declaration; and the model sees a 43 KB snapshot of something else. Any change must be made in at least four places (`UNIVERSAL_*`, `BRAIN_MUTATIONS`, `BOOK_BRANCH_ACTIONS`, the union builders, `prepareArguments`, the target-level projection). This is where "too complicated" is most literally true: **roughly 500 of book.mjs's 1,273 lines exist to serve the legacy interface and the projection/surgery machinery** (legacy runners ~665-850, union builders ~863-938, `bookBranchVariants/bookBranch*`/`specializeOperation` ~960-1154, the legacy arms of `prepareArguments`/`execute`), and **all 335 lines of `src/tool-schemas.mjs` exist for the replay lifecycle.**

### H6 — Inconsistent dispatch semantics for local reads
From the orchestrator, `book report inspect ref …` and `… durable list/inspect/read` dispatch an entire `task` focus (a forked conversation with its own 30-reply budget) to read local files; `report list`, `atlas read`, all brain reads, and `shelf list` run inline. The splitting rule is an ad-hoc boolean expression (`externalWork`, `book.mjs:~1232`), not a declared capability property, and it contradicts the design doc ("brain-scoped book operations are directly available").

### H7 — The whole design is welded to one provider adapter
`beforeProviderRequest` throws unless `model.api === "openai-completions"` (`src/tool-schemas.mjs:227`). That is not a fallback, a degradation path, or documented anywhere — any server reached through another adapter class (or a pi-durable upgrade that renames the `api` value) hard-fails every request with no working tools at all. The llama.cpp flat-object constraint (README, line ~65) is also violated by the stored validation schema if it were ever sent directly — the design depends on the swap never failing.

### M1 — Canonicalization and stale-version bugs
`digestJson` is `sha256(JSON.stringify(value))` (`book.mjs:65`) — key-order dependent, not canonical. Any re-serialization that reorders keys (e.g. `applyAtlasOp` rebuilding node objects) silently changes a record's "content version", invalidating pinned refs and `expectedVersion` preconditions without any content change. The 4A contract requires canonical bytes; this is not it.

### M2 — Write amplification on read paths
Every `list`/`inspect` for `ledger|plan|atlas|assessment|practice|context|conversation|prompt|tool|schema` calls `retainReferenceVersion` — a full catalog load, SHA-256 of the record, and a file write **per record per call** (`book.mjs:279,343,354,383`). Every collapse re-hashes shelved files and rewrites `catalog.json` (`observeFile` → `saveCatalog` unconditionally, `catalog.mjs:~180`). Every `book file inspect` rewrites `catalog.json`. None of these are needed for un-pinned reads.

### M3 — Unbounded scans and output; N+1 snapshot reads
`durableRecords` (`book.mjs:139-201`) walks every conversation and every entry on every `message list`, `toolCall list`, `toolResult list`, `prompt list`; nested results are fetched one `NestedCallDoc` read per nested call inside the loop. `message list` emits unbounded output. A long-lived session pays this cost per call; nothing paginates or caps it.

### M4 — Durable-call identity uses composite JSON strings as IDs
`toolCall` ids are `JSON.stringify([conversationId, entryId, callId])` and nested results are `nested:{…}` (`book.mjs:163-194`) — valid as opaque envelopes but they break `validateReference`'s kind/id discipline expectations elsewhere, are meaningless across a namespace rotation (`carto --fork-brain` rebinds `{namespace,kind,id,version?}` refs, not opaque composites), and collide with the `ref.id ≤ 256 chars` rule for large ids. They also prevent the reference catalog from indexing these records by construction.

### M5 — Soft-forget is two stores with no transaction
`message edit` writes a `carto.book.soft-forget` entry via `api.commit`, then a separate `updateContext` writes `forgottenEntries` and strips shelves (`book.mjs:~300`). A crash between the two leaves the message forgotten in one store and visible in the other (the commit check makes the *entry* idempotent; nothing makes the context-file side idempotent).

### M6 — Hidden continuation messages, stripping debt on every request
The invisible `\u2063` user message is exclusively the replay sentinel (wake notes use a separate marked note via `isNoChat`, `src/wake.mjs:58-92`), so the coupling is contained — but `forRequest` must recognize and strip it forever, together with the diagnostics markers and the hidden probe tool calls, on every request. That debt is inherent to the replay design, not to the `\u2063` byte. (One consequence worth flagging for the redesign: the continuation counts as a reply for `mainTurns`/`taskTurns`, and `hasReplay` short-circuits `onYield`, so replay rounds consume the user-visible turn budget.)

### M7 — Failure handling is a permanent re-injection, not a graceful degradation
On operation failure the branch state is retained (correct in intent) — but the model is re-fed the same multi-KB dump before every request forever, with no diff, no attempt count and no indication the same call already failed. `replayAttempts` increments only for bare-target intercepts, so full-but-invalid calls can fail without limit; when the 3-attempt apology does fire, the user sees an unexplained plain-text refusal. `loopCheck` is disabled for bare branch calls; for full calls it applies, but varied invalid calls slip the net. (See §3.2/§3.3.)

### L1 — Dead code and dead exports
`routeResults` path; `normalizeTool.execute` branch-request branch; `MAIN_TOOLS` (`src/prompt.mjs:168`) — imported by `src/harness.mjs:10`, never used;
- `describe("context")` / the `TOOLS.context` catalog entry (`src/prompt.mjs:27`) — no tool named `context` is registered, yet it advertises `fold`/`shelve`/`collapse`;
- the `TOOLS.book` description text advertising operations that fail closed (`src/prompt.mjs:17`) — see H4; `bookBranchParameters/bookTargetParameters/bookBranchVariants` (used only by the replay machinery and the schema entities nobody fetches); `UNIVERSAL_TARGETS/Actions`, `BRAIN_*`, `DURABLE_TARGETS` (six parallel capability tables); `details.selectedSchemaRef` (written, never read anywhere else); `hasReplay` continuation handling duplicated in `onYield`.

### L2 — Docs and README diverge from the code
README still says `write`, `edit`, `read` are "internal … not model-callable" (they are registered and callable by focus contexts — `harness.mjs` registers `lookTools`/`changeTools` and `beforeTool` only refuses them for the orchestrator), lists tools that no longer exist (`window`, `context`), and the Tests section + Files table reference `DO_NOT_RUN_TESTS_UNTIL_FINAL_STAGE/{run.mjs,stand-in.mjs,vt.py}`, paths that do not exist in the tree (the real files were `test/*` and were deleted; the rename was applied to the README but the files were removed). "The tools are eighteen flat objects" is stale (there are 14). The 4A/5 progress note claims Stage 5 "complete" while its own exit criteria (example retention, collapse-budget reservation, endpoint verification) are unimplemented.

### L3 — Small correctness and hygiene notes
- Non-atomic same-name temp files in `saveLedger`/`saveBooks` (`${path}.${pid}.tmp` reused across concurrent writes).
- `unsupported()` message (`book.mjs:73`) is fine, but `target=report&action=list` bypasses the universal dispatch into a special case (`book.mjs:~458`) — the dispatch table is not actually a table.
- `currentShelf()` (`book.mjs:60`) re-loads and re-parses `carto-context.json` three times per shelf call path.
- `report list` re-reads every report file in full just to list them (`loadReport` per row).
- `shelf add` accepts `ref.kind === "schema"` only with an exact pinned version; the analogous pin is not applied to `report`/`message` (live re-render only). Inconsistent but intentional per the Stage-3 file exception — keep, document.
- `tool-schemas.mjs` hardcodes the routing prompt strings and `Routed.` instead of centralizing them (violates the confirmed central-configuration direction).
- `applyContextRowAction` and friends are called with `api.taskId` as `operationId`, reusing the *tool-call* id as the store-level idempotency key — fine, but collision-prone across replay semantics for `atlas` (`atlas.lastCall = api.taskId`) and fine elsewhere; worth a comment, not a change.
- `digestJson(record)` versions for brain records make `expectedVersion` churn on every save even when nothing changed semantically (e.g. `lastCall` is stripped from `record`? — it is *not* stripped for ledger/plan `current.version`, so `lastCall` participates in the digest and changes on every call; expectedVersion then never matches for a record the model just inspected, defeating the precondition check in practice). **Verify:** `brainRecord()` returns `digestJson(record)` where `record = loaded.ledger.items.find(...)` — items do not carry `lastCall` (it is at `ledger.lastCall`, top-level), so this is OK for ledger/plan. Atlas nodes: nodes are plain objects; OK. Not a bug, but the pattern is one field-addition away from being one.

---

## 5. Root causes

1. **A provider limitation was answered at the wrong layer.** "llama.cpp/Qwen cannot build a grammar for a root `oneOf`/for strict mode" is true; the correct fix is a flat root schema (which the old pre-universal `context` tool had: `required: ["action"]`, flat enum — the base-suite test even asserts it). Instead, the schema was *withheld* from the provider and pushed into the conversation, turning a static declaration problem into a dynamic protocol the model must learn mid-session.
2. **The settled `target`+`action` contract was never re-examined after the ceremony was added.** Once interception existed, every target/action combination inherited it, including brain mutations that need nothing more than good local errors.
3. **Compatibility was kept for one release too long.** Legacy `book`/`ops` forced `BOOK_CONDITIONS`/allOf to survive into the projection engine (`bookBranchParameters` throws unless the schema matches the legacy shape exactly) — legacy compatibility is the load-bearing wall for the most convoluted code in the repo.
4. **Two documentation systems for the same grammar** (descriptions+comments vs. pi-schema unions vs. hand-written spec hooks) with no single owner, so each added constraint was written twice and each new branch multiplied the surface.
5. **No end-to-end rehearsal.** The only verification possible in this environment (stand-in server, canned model behaviors) was deferred to Stage 8; Stage 5 shipped on inspection alone, and the inspection was passed by the same author of the ceremony. The deleted suite — which at minimum pinned the *old* tool surface — was not adapted until now, and the routing path has zero coverage anywhere.

---

## 6. The refactor

**Design principles**

1. The provider declaration is **static, flat, and weak**; everything semantic happens **locally**, where errors can be precise. (This is the same trade the pre-universal `context` tool made successfully, and exactly what llama.cpp's grammar constrained decoding can carry at the root.)
2. **One** encoding of the per-branch grammar: a declarative capability table that drives (a) local validation, (b) the capability matrix shown to the model, (c) dispatch. No projection, no surgery, no allOf/if/then/not anywhere.
3. Nothing is ever injected into the conversation that the model did not ask for. On-demand documentation is an **operation**, not a replay.
4. The Stage 4 identity catalog is kept wholesale — it solves the right problem, and the universal-ID direction stays the source of truth for everything agent-known.
5. Unsupported is always better than clever: fail closed with an actionable message.

### 6.1 Provider-visible declaration (final shape)

Flat root object; no `anyOf`/`oneOf`/`allOf` at the root; every property optional except `target` and `action`; `additionalProperties: false`; closed enums; llama.cpp-safe by construction:

```jsonc
{
  "type": "object",
  "properties": {
    "target":   { "type": "string", "enum": ["file","report","ledger","plan","atlas","assessment","practice","context",
                                              "conversation","message","toolCall","toolResult","prompt","tool","schema","shelf"],
                  "description": "Which referenced entity family." },
    "action":   { "type": "string", "enum": ["inspect","read","list","create","add","edit","done","archive","restore","remove",
                                              "recall","before","link","unlink","confirm","rebind","fold","note","collapse","tree"],
                  "description": "One operation; the capability matrix in the tool description lists what each target supports." },
    "ref":             { "type": "object", "description": "Stable {namespace,kind,id,version?} reference to an existing entity. Required for operations on named entities; never a path or a label." },
    "path":            { "type": "string", "description": "Explicit project-relative path; file inspect/read/create/shelf add only." },
    "range":           { "type": "string", "description": "Lines like \"10-80\"; files only." },
    "placementId":     { "type": "string", "description": "Shelf placement ID (sh-…) for shelf remove. Not the target's entity id." },
    "planItem":        { "type": "string", "description": "Authorized change-plan item for file create/edit." },
    "expectedVersion": { "type": "string", "description": "SHA-256 content version the edit is based on; stale versions are rejected." },
    "content":         { "type": "string", "description": "Whole UTF-8 text for file create." },
    "oldText":         { "type": "string" },
    "newText":         { "type": "string" },
    "handOn":          { "type": "boolean", "description": "In a focus: hand this shelf placement to the orchestrator on return." },
    "operation":       { "type": "object", "description": "Brain-record payload for add/edit/done/remove/before/archive/restore: target-specific fields, e.g. ledger add = {kind:\"goal\", text:\"…\", done_when:\"…\"}. Omit `action` inside; the call's action is the operation." }
  },
  "required": ["target","action"],
  "additionalProperties": false
}
```

~1.6–2.0 KB of schema; description grows to carry a compact matrix (~1,300 tokens total including today's text). Cache-stable, identical in every request and every focus fork.

**Tool description addition** (one line per target, kept terse):

```
file: inspect/read by path or ref; create/edit for an authorized change plan item (create needs path+content+planItem; edit needs ref+expectedVersion+oldText+newText); rebind to a moved file.
report: list; inspect/read/recall by ref; archive/restore/remove need expectedVersion or a pinned ref.
ledger: list/inspect/read; add/edit/done/remove with operation {kind,text[,done_when]}; goals need done_when.
plan: same shape; plan edits are orchestrator-only; reorder with before.
atlas: list/inspect/read; add/edit/link/unlink/confirm/remove; main only: tree {anchor?,depth?}.
assessment|practice: list/inspect/read; add/edit/done/remove/before.
context: list/inspect/read; add/edit/done/remove/before/archive/restore; fold <report|step ids>; note; collapse.
conversation|message|toolCall|toolResult|prompt|tool|schema: list/inspect/read by ref; message edit = soft-forget.
shelf: list; add (file ref or path[+range]; report ref; schema ref with pinned version); remove by placementId.
Full per-action field grammar: book target=schema action=read ref={…} with the id that `schema list` reports.
```

### 6.2 Local validation: one table, four consumers

A single declarative `CAPABILITIES` object keyed `target → action → spec`:

```js
// spec: { fields?: {name: {type, required?, pattern?, max?, oneOf?}}, ref?: "required"|"optional"|null,
//         refKind?: string, versionPrecondition?: bool, route?: "inline"|"focus", gate?, impl: (…) => … }
const CAPABILITIES = {
  file: {
    read:   { ref: "optional", pathOk: true, range: true, impl: … },
    inspect:{ ref: "optional", pathOk: true, impl: … },
    create: { fields: { path: req(), content: req(), planItem: req() }, route: "focus", gate: "change-plan", impl: … },
    edit:   { ref: "required", refKind: "file", versionPrecondition: true, fields: { oldText: req(), newText: req() }, route: "focus", gate: "change-plan", impl: … },
    rebind: { ref: "required", refKind: "file", versionPrecondition: true, fields: { path: req() }, impl: … },
  },
  plan: {
    add:    { ref: null, fields: { operation: brainAdd(PLAN_ADD) }, gate: "orchestrator", impl: … }, // allows mode/text/network/standing/before
    …
  },
  context: {
    fold:    { fields: { id: {type:"string", required:true}, /* or ids list */ }, impl: … },   // restored from legacy
    note:    { fields: { text: req() }, impl: … },                                            // restored
    collapse:{ fields: { text: opt() }, impl: … },                                            // restored
    archive: { ref: "required", refKind: "contextRow", versionPrecondition: true, impl: … },
    …
  },
  shelf: { … }, …
};
```

`prepareArguments` is a generic interpreter over this table (replacing both the pi-schema `BOOK_CONDITIONS` and the hand-rolled `requireRef()` ladder, keeping their wording quality: same messages, one generator). `betweenBranch` compatibility checks become ordinary field validation. Everything the table cannot express does not exist (that is the point).

The `operation` payload keeps the existing pi-schema unions **only** as local validators for those payloads (`EXEC_LEDGER_OP` etc.), or — better, to retire the union objects entirely — the existing hand-written spec engines (`applyOp`, `applyBookOp`, `applyCuratedRowOp`, `applyAtlasOp`) **already** validate exhaustively with good messages; the unions were duplicated enforcement. Decision for the implementation phase: delete the unions; rely on the spec engines; keep three or four spec-level error overrides (plan add shape hint, ledger done_when) as post-validation touch-ups. This leaves exactly one validator per domain.

### 6.3 On-demand documentation, the honest version

- `book target=schema action=read ref={…}` with an id from `schema list` returns the exact, content-addressed field grammar for that target — the same text the model would have needed, produced from `CAPABILITIES` (deterministic, canonical, small: no `null` sentinels, no anyOf trees; typically 30–60 lines of YAML-ish text).
- The matrix in the description says where to find it; an unfamiliar model can `book schema list` and pin any tool/branch schema on its shelf as a normal reference entity (this is Stage 4's original idea, finally whole).
- No injection, no replay, no markers, no continuation sentinel, no Context-tab pollution, no extra round-trip. The 335-line schema-lifecycle module reduces to: `schema` target reads from the catalog (`readReferenceVersion`) — already implemented, already correct.

### 6.4 Dispatch policy, declared not hardcoded

Each capability spec carries `route: "inline" | "focus"` and, when focus, `gate`:

| Route | Applies to | Why |
|---|---|---|
| `inline` | all brain/report/durable/shelf *reads*; all brain mutations; rebind (version-checked, local) | local, deterministic, no reason to fork a conversation |
| `focus` | `file create|edit` (+ `shelf add` when called from orchestrator needing `handOn`) | plan/approval/sandbox/network confinement; the orchestrator may not write |
| gate `orchestrator` | all `plan *` mutations; `wake`/`sleep` (not book targets) | existing boundary |
| gate `soft-forget` | `message edit` | journal + idempotent, unchanged semantics |

Deliberate change from today: orchestrator `report inspect/read`, `* list/inspect/read` for durable targets, and `shelf list` move from a forked focus to **inline** execution — this is the declared-capability answer to H6; the orchestrator/file-inspect boundary is separately kept (open question below).

`focus` hand-off still passes the call's exact arguments as structured JSON in the brief (existing `task` mechanism, unchanged gates), but the focus also receives a dedicated `carto.focus-op` entry naming the operation and its `expectedVersion` so approval/verification does not depend on parsing prose.

**Open question (§8):** whether orchestrator `file inspect/read` should also become inline. That boundary is deliberate today ("The orchestrating context does not inspect project files directly") and I have kept it.

### 6.5 The `fold`/`note`/`collapse` gap, closed

`context` gains first-class actions `fold` (report id or task step ids, existing semantics), `note` (task notes; refused for orchestrator with the existing `REFUSALS.mainNotes`), `collapse` (request a collapse of this context; same semantics as legacy), restoring parity with the pre-universal tool. Shelf verbs stay on the `shelf` target (`add|remove` by placementId) — one interception point for placement lifecycle. Legacy `shelve/unshelve` ops become unreachable after deletion (the universal equivalent is `shelf add/remove`); fold/note/collapse become first-class `context` actions, not legacy-only.

### 6.6 Durable/reference resolution engineering

- **Index, not scans.** `.atlas/catalog/index.json` (namespace-scoped): `id → {kind, conversationId?, entryId?, taskId?, version, summary, role?}` updated by the two hooks that already see everything (`GenerationTask.afterResponse` for messages/tool calls; `ToolTask.afterTool` for results) and backfilled lazily on first use. `list` becomes `SELECT * WHERE kind=?` over the index with stable sort and a hard cap (`POLICY.limits.…listCap`, default 200 lines) with a cursor. `inspect/read` are index + direct entry reads. This kills M3's O(n²) behavior and the N+1 `NestedCallDoc` reads (nested results get index entries with their parent composite ids; snapshot reads happen only on `read`, not on `list`).
- **Canonical versions.** Replace `digestJson` with deterministic stringify (sorted keys, no whitespace) for all non-file versions; keep bytes-hash for files. Re-pinning the same logical record stabilizes `expectedVersion`.
- **No write-on-read.** `retainReferenceVersion` runs only at: explicit pin (`shelf add` of schema), `fold`/`archive` of a report? (no — archived rows already persist), fork journal operations, and migration. `list/inspect/read` never write. `observeFile` stops saving the catalog when nothing changed (compare mtime/digest before `saveCatalog`) — this alone removes the per-collapse rewrite.
- **Composite ids.** `toolCall`/`toolResult`/`nested` refs remain composites but become dotted opaque strings (`tc:<conversation>:<entry>:<callId>`, `nt:<parent>:<parentCallId>:<key>`) — still opaque, still namespace-safe, still under the 256-char cap for realistic ids, and they no longer abuse JSON as an id format.
- **Soft-forget atomicity.** The `carto.book.soft-forget` entry and the context-store update are committed in one order with a crash-recovery scan: on load, `forgottenEntries` reconciles against soft-forget markers written by the *same* `operationId` (already scanned for idempotency); a missing context-side entry is rebuilt from the markers. Full elimination needs storage below Durable's API, so reconcile-on-load is the honest fix.

### 6.7 Budget and token accounting after the refactor

There is no schema material in requests anymore, so:

- `engine.sizes()` `fixed` again measures only prompt+tools; `collapseFull` behaves as before; the chars/4 estimate gets a `calibration` note (do not pretend it is a tokenizer) and stays a fallback until a server tokenizer is available — the 4A "prompt-input ceiling" policy remains a separate, later work item that this refactor does not pretend to solve.
- The `contextShare`-derived `schemaBudgetTokens` policy is deleted along with `tool-schemas.mjs`; in its place, the description carries ~350 tokens of stable matrix (counted once, cached).
- Capability-spec changes that grow request size fail loudly at build/validation time (a unit-ish check in the migration stage, not a runtime budget).

### 6.8 File-level change plan

**Delete outright**
- `src/tool-schemas.mjs` (335)
- `src/tools/book.mjs` sections: `UNIVERSAL_TARGETS/UNIVERSAL_ACTIONS/BRAIN_TARGETS/BRAIN_MUTATIONS/DURABLE_TARGETS`, `LEDGER_OP/PLAN_OP/BOOKS_OP/CONTEXT_OP/BOOK_CONDITIONS/branchFor`, `schemaAllowsNull/nonNullSchema/withNullable`, `bookBranchVariants/bookBranchParameters/bookTargetParameters/specializeOperation/operationBranch`, `bookReplayContext`, legacy `book`/`ops`/`text` handling in `prepareArguments`+`execute`, `BOOK_BRANCH_ACTIONS` (subsumed by the capability table).
- `src/prompt.mjs` `MAIN_TOOLS` (unused); `describe("context")` and other orphan tool descriptions left over from the merge (verify each against the current registry).
- `src/harness.mjs`: `schemaLifecycle` creation, `normalizeTool` loop, the `beforeTool`/`afterTool` schema branches, the `isBookBranchRequest`/`loopCheck` carve-out, the `hasReplay` onYield branch; the `SchemaLifecycle` import.
- `src/request.mjs`: `schemaLifecycle` parameter and `forRequest` call.

**Rewrite (new `src/tools/book.mjs`, ~450–550 lines)**
- Declaration builder from §6.1; `CAPABILITIES` table; generic `validate`; `prepareArguments`; `execute` dispatch by `route`; per-domain runners (`runLedger/runPlan/runBooks/runContext` — keep, but drop the `ops[]` envelope; they take the operation object directly); universal resolvers for file/report/durable/shelf (keep logic, canonicalize, drop inline `digestJson`, add the index).
- Restored `context` actions `fold`, `note`, `collapse` (implementations moved from the legacy path, unchanged semantics).
- `atlas` support: keep as-is through `applyAtlasOp` under `target=atlas`. Decide the fate of the standalone `atlas` tool (see §8 Q1): either delete it (one surface for the model) or keep it as a thin alias for one release. My recommendation: **delete**; a two-route entry point for one engine is the same disease in miniature. `tree` (orchestrator-only) becomes `book target=atlas action=tree` gated to orchestrator — or, if you prefer zero new surface, keep `atlas` tool *only* for `look|tree`. This is a judgment call flagged for you.

**Catalog (`src/catalog.mjs`)**
- canonical stringify helper; `observeFile` no-op writes; `retainReferenceVersion` gated to explicit pins; deterministic `entityVersionPath` (already hashed) with kind+id — unchanged; namespace/fork behavior unchanged.

**Context engine (`src/context.mjs`)**
- `SHELF_RESOLVERS` gains `message`/`toolCall`/`toolResult` live+pinned rendering (pinned requires retained version — thus only via explicit pins; live otherwise, with explicit `inaccessible` when gone). "Not found" wording unified.
- `shelfBlock` no longer re-pins file refs on every render; only refreshes content snapshots (as today) minus the catalog write.

**Docs & config**
- README: tools table (drop `window`/`context` rows; `write`/`edit`/`read` described as the focus-side file tools they are), tests section path `test/*`, Files table, "What has been tried" note that Stage-5 routing was removed and why.
- `docs/working-design/context-and-shelf.md`: add a dated entry recording this decision (superseded Stage 5 approach, kept Stage 5's *goals* minus the replay).
- `POLICY`: drop `limits.toolSchemas`; ensure `limits.bookTool.keptBookEntries` etc. remain accurate; add `limits.book.listCap`, `listCursorTokens`.

### 6.9 What this does to the numbers

| Metric | Today | After |
|---|---|---|
| Provider declaration bytes | **551** | ~1,900 |
| Fixed tool-description tokens | ~1,355 (all tools) | ~1,700 |
| Model invocations per book call (happy path) | **2 from a cold start** (routing round, then the reissue) | 1 |
| Stored junk entries per episode | 2 (assistant marker + `user \u2063`) | 0 |
| Worst-case transient schema text per request | ~11,000 tokens (plan/atlas), re-injected until success | 0 |
| `book plan` callable at 64k window | **no** (budget refusal) | yes |
| Validation encodings of one branch | 3–5 (declaration, projection, unions, imperative, spec hooks) | 1 (capability table + spec hooks) |
| Lines of code in `book.mjs` + `tool-schemas.mjs` | 1,608 | ~500–600 |

### 6.10 Rollout phases (each gated on its own review; tests stay disabled until you authorize Stage 8)

**Phase 1 — deletion and consolidation (no behavior change visible to the model except the deletion of the replay):** remove `tool-schemas.mjs`, the lifecycle wiring, the projection/union code, the legacy interface; introduce `CAPABILITIES` with identical semantics to today's universal table (including restoring `fold|note|collapse`). Deliverable: tree that passes `node --check` on all files and boots with a stubbed server by hand (you run it).

**Phase 2 — resolution engineering:** canonical versions; no-write-on-read; index; composite-id rendering; soft-forget reconcile; caps/pagination.

**Phase 3 — measurement:** rebuild the stand-in-driven flow to count actual bytes/round-trips per operation against a local stub (no real model claims until you exercise a live server). Decide: is the matrix+errors sufficient for the configured 0.6B-class model, or do we need the branch text appended to *local validation error messages* (cheap: on failure, the returned error may include the branch grammar — errors are not budget-bound the same way, and only appear on failure)? My recommendation if Phase 3 shows the model floundering: **append the target's action/field summary to the local error string** (one or two lines per action, ≤150 tokens, only on failure). This is graceful degradation with zero ceremony on the happy path.

**Phase 4 — tests (only when you authorize running them):** see §9.

**Phase 5 — docs:** README/context-and-shelf/AGENTS updates; removal of the stale claims; a short "universal books, verified" section replacing the "Stage 5 complete" claim with what was actually verified, where, and against which server.

---

## 7. What is explicitly *not* in scope

- The Stage 6 collapse-cluster redesign, Stage 7 focus boundaries, and the 4A "prompt-input ceiling" policy (server-tokenizer headroom guarantee) are real, needed, and separate. This refactor removes the specific Stage-5 mechanism, not the budget problem in general — after deletion there is nothing transient to budget, but the *static* reservation question for `maxTokens` + shelf + chat window stays open.
- The universal identity catalog (namespace policy, fork/rebind, `.cartoignore` semantics) is kept as confirmed; only canonicalization and write-amplification change.
- The orchestrator/focus file-inspection boundary is unchanged (question for you in §8).
- `wake`/`sleep` stay orchestrator-only and are not `book` targets (reconfirm in §8).

---

## 8. Decisions I need from you

1. **`atlas` tool:**~~ — RESOLVED 2026-11-15: clean fold, no alias; verb enumeration ported into the book description; `tree` stays in book's atlas target (Appendix G). (Was: fold entirely into `book`, or keep a minimal `look|tree` alias for one release?)
2. **Orchestrator file inspection:** keep "the orchestrating context does not read project files directly" (my default), or allow inline `file inspect/read` for the orchestrator (it would make the report/durable read inline policy consistent)?
3. **Error-attached guidance fallback** (Phase 3): pre-authorized if the live server flounders, or not?
4. **Tests:** restore `test/` from `cea8468` as the migration base and adapt (my recommendation, per §9), or write fresh acceptance tests from the Stage 4/5 exit criteria and keep the old suite only as reference? Either way, nothing runs until you say so.
5. **Retained-version hygiene:** is a retention cap (e.g. keep last N versions per entity, default N=50, plus everything pinned from a shelf) acceptable for `.atlas/catalog/entities/`, or keep everything forever?
6. **`prompt`/`tool`/`schema` targets:** keep `list` as-is (summaries only, but unbounded in count and walked from scratch each call) with a hard cap and cursor, or restrict these to `inspect|read` of a known id?
7. **Soft-forget:** acceptable that raw Durable transcript and the reconcile markers remain forever (documented as such), or do you want an explicit user-facing "forget hard" story in the UI? (Not erasure — the transcript is append-only — but stronger wording/controls.)
8. **Namespace-qualified ids in the state block:** stay domain-short (current: `g1`, `p2`, `t12`) or show universal refs? I recommend staying short (ids are already namespaced via the store; the state block is for eyes).

---

## 9. Test triage (base suite at `cea8468`, `test/run.mjs`, 151 tests)

The suite was written against the pre-universal tool surface and drives a scripted stand-in (`test/stand-in.mjs`) whose directives name removed tools (`ledger: [OPS]`, `plan: [OPS]`, `context: {…}`, `assess: TEXT`, `atlas: [OPS]` — ~104 occurrences, 58 of them `context:`). It cannot run unchanged; none of it can be run yet anyway (AGENTS.md; `npm test` is hard-blocked).

| Group | Count | Disposition |
|---|---|---|
| launch / brain / install / time / screen / terminal / thinking / repeat / loop / notes | 40 | **Keep nearly verbatim.** They script no removed tool names (screen/terminal tests exercise the TUI and are untouched by the refactor). |
| context (`collapse`, shelf, recall, fold, handoff question, read-ahead, sizes) | 26 | **Port.** Mechanism tests are all valid; scripts change `context: {…}` → `book: {"target":"context",…}` and `shelf`/`drop`→`fold` renames; the one assertion on the old `context` schema enum is rewritten; "tools are eighteen flat objects" becomes "the current tool inventory, flat-root objects". |
| ledger (4), plan (5), assessment (1) | 10 | **Port.** Calls become `book target=ledger/plan/books …` with `operation` payloads; validation-error substrings asserted will need re-wording but the assertions on behavior (authorization, withdrawal, limits) stay. |
| atlas (7) | 7 | **Port** to `book target=atlas` (or keep against the alias in Q1); operations identical. |
| task (9), wake/wakes (14), shell/windows/bwrap/yolo (20), change/checkpoints/undo (6) | 49 | **Port mechanically** (mostly unchanged; only scripted calls naming `context:`/`ledger:` inside briefs change). The safety-gate assertions (refusals, sandboxing, undo) are the most valuable tests in the suite and must survive. |
| ask (2), chat (2), look (3), top (2), tree (1), kill (2) | 12 | **Keep/port.** |
| — | 3 | **Delete.** Tests pinning removed mechanics: the schema-block order in `dressRequest` assertions that mention the routing marker machinery (none exist by name — none were written), plus the two tests asserting the literal refusal text of the old `context` tool (merge into new book-error tests). |
| — | — | **Add new ( acceptance):** book happy paths per target; unsupported `target/action` fails closed; missing-`ref` errors name the field; stale `expectedVersion` refused; routing-free single round-trip assertion (stand-in counts `requests`); `fold`/`note`/`collapse` through `context`; shelf by placementId; message soft-forget flow; `expectedVersion` stability across saves (canonical digest); `schema` on-demand read; index correctness vs. full scan equivalence; `list` cap and cursor. |

Estimated porting effort: the stand-in gains `book: {JSON}` as its directive (one parser), the number of distinct engine call-shapes is small, and most edits are mechanical. **Do not** resurrect the suite until Phase 4; when it is resurrected, it must be *adapted*, never bulk-applied and accepted on green.

Also: restore `test/stand-in.mjs` and `test/vt.py` paths exactly (README links must match the tree), and update the README test description to the real behavior (env-dependent skips: bubblewrap, python3, llama.cpp).

---

## 10. Risks and honest unknowns

- **Model behavior is the real acceptance test.** This document is not evidence that a 0.6B Qwen will call `book plan` correctly from the matrix + errors alone. It will not be worse than today's ceremony — every failure mode of today's design is a strict superset of failure modes here — but it may not be fluent. Phase 3 exists to measure this; the fallback (§6.3 note / §8 Q3) is cheap.
- **The collapse/budget story is unchanged in essence.** Removing transient schema material closes the specific Stage-5 hole; the static ceiling (server-reported usage as the only real signal) remains as it is, and remains the 4A agenda.
- **The universal catalog is now load-bearing for correctness** (canonical digests; index integrity). The migration must be additive and reversible: old refs remain valid because kind/id/namespace are untouched; only `digestJson` call sites change to canonical form, which changes versions *once* for records whose key order wasn't already sorted — expectedVersion mismatches on first use are possible but fail closed (actionable error, retry passes). Mitigate by keeping `expectedVersion` failures' messages instructive (they already are).
- **Deleting the legacy interface** means any in-flight sessions carrying `{book,ops}` payloads produce a clean refusal with a one-line migration hint instead of executing. Given `carto` sessions are per-project and the Stage-4/5 data formats are untouched, this is acceptable and is called out in the tool description for one release.
- **I verified no hidden consumers** of the deleted exports outside this repository module tree (`grep` for `bookBranch*`, `bookTargetParameters`, `createToolSchemaLifecycle`, `schemaLifecycle`, `BOOK_BRANCH_ACTIONS`): all are consumed only by the two modules being removed. `details.selectedSchemaRef`/`schemaSelection`/`schemaRef` are written into stored tool results; nothing renders them, nothing reads them — they become inert metadata in old transcripts.
- **Sizes** in §2.2 are `chars/4` estimates, not server counts; treat them as orders of magnitude, and measure again against the real server at Stage 8.

---

## Appendix A — measurement commands

```bash
npm install            # dependencies were installed to obtain real numbers
node -e 'import("./src/tools/book.mjs").then(async (m)=>{
  const stub={messagesOf:()=>[],want(){},afterMainCall:async()=>undefined};
  const t=m.bookTool({root:"/tmp",brainDir:"/tmp",config:{shelfTokens:12000},engine:stub,gate:{yolo:false}});
  console.log(JSON.stringify(t.parameters).length, t.description.length);
  for (const [k] of Object.entries(m.BOOK_BRANCH_ACTIONS)) console.log(k, JSON.stringify(m.bookTargetParameters(structuredClone(t.parameters), k)).length);
})'
node -e 'import("./src/tool-schemas.mjs").then(async (m)=>{
  const b=await import("./src/tools/book.mjs");
  const stub={messagesOf:()=>[],want(){},afterMainCall:async()=>undefined};
  const t=b.bookTool({root:"/tmp",brainDir:"/tmp",config:{shelfTokens:12000},engine:stub,gate:{yolo:false}});
  const l=m.createToolSchemaLifecycle([t],{schemaBudgetTokens:100000});
  const nt=l.normalizeTool(t);
  for (const k of Object.keys(b.BOOK_BRANCH_ACTIONS)) {
    const r=await nt.execute({target:k},{conversationId:"c"+k,now:()=>Date.now(),taskId:"t"});
    const p=l.pending.get("c"+k); console.log(k, r.isError?"ERR":"ok", p?.contextText?.length, Math.ceil((p?.contextText?.length+32)/4));
  }
})'
```

## Appendix B — file:line evidence index

`src/tools/book.mjs`: universes `UNIVERSAL_TARGETS/ACTIONS` 26–27 · `digestJson` 65 · `BRAIN_TARGETS` 67 · `durableRecords`/`durableEntries` 139–201 · `runUniversal` 203–533 · `report list` special case 433 · `shelf add` ~470–491 · `runContext` legacy ops 665–850 · `LEDGER_OP` 863 · `PLAN_OP` 879 · `BOOKS_OP` 894 · `CONTEXT_OP` 902 · `BOOK_CONDITIONS` 925 · `bookBranchVariants` 960 · `bookBranchParameters` 971 · `bookTargetParameters` 1074 · `specializeOperation` 1107 · `BOOK_BRANCH_ACTIONS` 939–955 · validation schema `allOf: BOOK_CONDITIONS` 1173 · imperative checks ~1190 · `execute` dispatch + focus routing ~1230 · legacy runner select ~1242.
`src/tool-schemas.mjs`: `BOOK_COMPACT_PARAMETERS` 11–23 (**551 B** as shipped) · `strictSchema` 39–57 · `cleanNullableArgs`/`matchesSchema` 59–132 · `isBookBranchRequest` 100–102 · `loadBookBranch` 124–147 · `interceptBookRouting` 159–199 (`attempts >= 3` apology at 166–171; emptied message at `message.content = []`) · `normalizeTool` 204–224 · `beforeProviderRequest` 226–233 (**throws unless `model.api === "openai-completions"`**) · `beforeTool` 236–242 · `afterTool` 253–269 · `forRequest` 271–332.
`src/harness.mjs`: `schemaLifecycle` creation 247–249 · unused `MAIN_TOOLS` import 10 · `beforeTool` hook 261 · `afterTool` hook 283–323 (`isBookBranchRequest` carve-out 286) · `beforeRequest` 318–336 · `beforeProviderRequest` 349–354 · `afterResponse` 355–366 · `onYield` replay branch 371 · `steps` counting 312–320.
`src/prompt.mjs`: book description 17 · stale `TOOLS.context` 27 · HANDOFF text instructing `fold`/`shelve`/`collapse` via book context operations 56, 223, 240 · `MAIN_TOOLS` 168.
`src/engine.mjs`: `full()` 72 · collapse decision at 242 (`collapseFull = 80`, `src/config.mjs:94`).
`src/request.mjs`: `schemaLifecycle.forRequest` injected at 85–87 (parameter at 82).
`src/catalog.mjs`: `observeFile`→`saveCatalog` ~180 · `resolveFile` re-observes ~230 · `nativeReference` (writes catalog if missing) ~290 · `retainReferenceVersion` ~318 · `readReferenceVersion` ~340.
`src/context.mjs`: `shelfBlock` ~649 · `shelfItem`/`fileReference` on render ~602–648.
`README.md`: tools table rows 369–381 (`window`, `context` stale) · line 373/383 (`read`/`write`/`edit` "not model-callable", false) · Tests 993–1027 · Files 1081–1083 · "eighteen flat objects" in test line 1005-ish (in `test/run.mjs` at `cea8468`: `test("context: … tools are eighteen flat objects"…`)).
`docs/working-design/context-and-shelf.md`: Stage 5 spec + "Implementation progress (2026-11-13)" — the claims this review marks unimplemented; Stage 4A contract items 4A–8 that remain valid and are kept.

## Appendix C — the one-paragraph summary for the decision maker

Deleting the routing ceremony does not weaken the confirmed Stage-4/5 intent: everything agent-known keeps a universal reference, the shelf keeps working as specified, plan authorization and sandbox gates are untouched, and tool schemas remain first-class referenced entities. It removes a hidden two-round protocol that (a) no model is told about, (b) erases the natural call and reissues it under a multi-KB schema user-message, (c) pollutes the stored conversation and the Context tab, (d) doubles per-call latency from the orchestrator, (e) cannot run `plan`/`atlas` on servers at or below ~64k context, and (f) is sustained by ~500 lines of the most brittle code in the repository, plus 335 more that exist only to feed it. The cost of the alternative has already been paid: the base test suite had to be deleted to keep the agent from running it, and it would have caught none of this.

## Appendix D — Phase 1 implementation record (2026-11-15, on this branch)

**Deleted outright**
- `src/tool-schemas.mjs` — the whole on-demand schema lifecycle (routing, strict-schema projection, replay bookkeeping, `beforeProviderRequest` swap, marker dressing, the `\u2063` continuation).
- `src/tools/book.mjs` — the legacy `{book,ops,text}` interface and dispatch tail; the union builders (`LEDGER_OP`/`PLAN_OP`/`BOOKS_OP`/`CONTEXT_OP`), `BOOK_CONDITIONS`, `BOOK_BRANCH_ACTIONS`, `bookBranchVariants/parameters`, `bookTargetParameters`, `specializeOperation`, `schemaAllowsNull/nonNullSchema/withNullable`, `UNIVERSAL_TARGETS/ACTIONS` (now derived from the table); the `hasRootPlanText`/`planAdds` error rewrites; the dual-interface validation.
- `src/config.mjs` — `limits.toolSchemas.contextShare`; unused legacy `enums.bookName/bookNames/bookToolActions`.
- `src/prompt.mjs` — `MAIN_TOOLS`; the stale `TOOLS.context` entry (advertised nonexistent operations); prompt sentences instructing `book` context operations that failed closed now name the real calls.
- `src/harness.mjs` — `schemaLifecycle` creation, the `normalizeTool` wrap, the schema refusal/rewrite in `beforeTool`, the replay carve-out in `loopCheck`, the `hasReplay` `onYield` branch; `MAIN_TOOLS` import.
- `src/request.mjs` — the `schemaLifecycle` parameter and the `forRequest` dressing call.

**Created / changed**
- `src/tools/book.mjs` — one flat declaration (2,265 B, root `additionalProperties: false`, closed `{type:"string", enum:[...]}` for target/action; no root `anyOf`/`oneOf`/`allOf`); `CAPABILITIES` (target → action → spec) as the single source of truth for the provider enums, local validation and the executor; a generic interpreter producing joined-reason messages (`file edit needs ref, expectedVersion, oldText, and newText.`); unsupported target/action pairs fail closed at validation; `context fold|note|collapse` restored (operation payloads, no ref/precondition; `fold` takes `{id}`, `note` takes `{text}`, `collapse` is free-form).
- `src/terminal.mjs` — result summary keys on `details.target === "context"` (the legacy `details.book` shape is gone).
- `README.md` — the two most misleading Stage-5 sentences corrected (flat static schemas; no provider-side expansion).
- The provider-visible tool is now the stored declaration itself: nothing is swapped at send time, on any adapter.

**Verification (offline; the app and the tests were not run)**
- `node --check` on every changed file; module import of `engine`/`request`/`harness`/`terminal`/`context` succeeds.
- The declaration serializes to 2,265 B with `additionalProperties: false`, `required: ["target","action"]`, 16 targets, 19 actions, no root `anyOf`/`oneOf`/`allOf`.
- 23 offline validation probes pass (happy paths per interface, fail-closed unsupported pairs, missing-field messages, version preconditions, legacy `{book,ops}` rejected, unknown property rejected).
- `systemPrompt` 7,673 chars (~1.9k tokens); tool descriptions totals barely move (~1.4k tokens); fixed per-request tool bytes ≈ 2.3 KB instead of ~600 B of compact enums plus up to ~11k tokens of on-demand schema injected mid-episode.
- Not yet done: any live-server behavior; Phase 2 (resolution engineering), Phase 5 (full README/design-doc pass), the §8 decisions listed in this document (atlas tool fate; retained-version retention; `prompt list` bound; soft-forget wording; state-block ref display) and the test port (§9).

## Appendix E — Phase 2 implementation record (2026-11-15, on this branch)

**What landed** (`ad73db6`, `c5c8b1f`, `2bee539`; nothing bottomed out until the offline harness passed)
- `src/index.mjs` (new) — Durable-record memo at `.atlas/catalog/index.json`: watermark probe (`indexFresh`) → else full derive; `durableSummaries` for list paths, `durableRecordFor` for point reads; soft-forget filter at query time; nested toolResult records filled outside the commit callback; `scanAll` exported; `stripValue` memo records tiny.
- `src/catalog.mjs` — `canonicalJson`/`contentVersion` (key-order independent) and `fileIdentityForPath` (bytes-hash for files); all read paths write-free; NEW `ensureCatalog(brainDir)` mints/verifies the namespace anchor exactly once (used everywhere refs are minted); `retainReferenceVersion` only at explicit pins.
- `src/config.mjs` — `POLICY.limits.book = { listCap: 200, listCursorTokens: 64 }`.
- `src/context.mjs` — soft-forget sidecar (`catalog/soft-forget.pending.json`, 0600, atomic rename): written post-commit, applied at load, unlinked when satisfied; **no writes on read**. Reference-placement backing: resolvers for message/toolCall/toolResult (pinned version → snapshot backing taken at add time, immutable content); `shelfReferenceItem` (idLine snapshot + full-content backing, namespaces kept); `persistShelfSnapshot` skips unchanged rewrites; `loadContext` sweeps backing files of placements the sidecar reconcile strips, via `cleanupShelfSnapshots(..., retainedStore)` (no load recursion); `shelfBlock` adopts file identity read-only.
- `src/tools/book.mjs` — every list (durable/brain/report) hard-capped at 200 refs with an opaque base64url `{o,k}` cursor (bound by `listCursorTokens*4` bytes, kind-checked); retain-on-read eliminated; all point reads via `durableRecordFor`; message edit crash recovery (replay detection incl. a durable marker scan that strips shelves when the store lost the update); markers appended idempotently by `operationId`; schema explicit pins are self-sufficient (retains the current registry version when missing, namespace-checked, wrong-version pins refused); message/toolCall/toolResult shelf adds backed by add-time verified content; namespace-qualified refs via `ensureCatalog`; declaration gained `cursor`; prompt notes the 200-ref cap.
- `src/prompt.mjs` — book description documents ≤200-ref lists + cursor.

**Verification (offline; the app and the tests were not run)**
- `node --check` on every touched file; scratch harness (since deleted) with a fake Durable world covered: fresh/cached lists (memo mtime stable on cached calls), pagination over 250 items across two pages, toolCall/toolResult/prompt/conversation lists, canonical-digest key-order stability, soft-forget end-to-end (marker → store → list filter), sidecar crash recovery incl. backing sweep, snapshot skip/rewrite behavior, file observe/resolve (external-edit → stale, catalog untouched), schema shelf pin (current version retained; wrong pin refused), report list/inspect/read/stale refusal, empty ledger/report/brain paths, shelf add-time backing render after soft-forget.

**Open**
- ~~Canonical-vs-legacy digest hazard~~ — RESOLVED 2026-11-15: the user chose the legacy fallback. Retained blobs are verified against both digests (canonical bytes, then `sha256(JSON.stringify(value))`); legacy matches are honored in place, never rewritten (`cfbc8a2`).
- ~~§6.6 afterTool/afterResponse hook~~ — RESOLVED 2026-11-15: the user chose lazy backfill; no write-path hook for now.
- §8 Q5 (retained-version retention cap) and Q6 (default `--frozen-lockfile`-adjacent review flag); Q3 (Phase 3 error-attached guidance) awaits live-server evidence.
- Phase 3 (error guidance), Phase 4 (test port), Phase 5 (docs) — not authorized.

## Appendix F — Phase 3 measurement (offline, 2026-11-15)

**Method.** Byte counts are UTF-8 lengths of `JSON.stringify`; token figures are bytes÷4 estimates (`charsPerToken: 4`); provider wrapper keys around each function declaration are identical across trees and were excluded. "On-wire at Stage-5" is the declaration the provider actually sent (the `BOOK_COMPACT_PARAMETERS` swap in the deleted `tool-schemas.mjs`); the branch figure is `strictSchema(bookTargetParameters(fullParameters, branch))` as injected mid-episode, measured on the `0e566c0` tree. Trees: Stage-5 = `0e566c0`, Phase-1 pre-memo = `3b3f23a`, HEAD = `18d3ee1`. The durable-read counts use a fake Durable world (226 entries: one system prompt, 110 user/assistant pairs, one model tool task + tool-result, one nested task; one watched task conversation, one observer conversation). **Nothing was run against a live server; nothing here is a claim about model behavior.** Measurement needed no network and no app launch; `node_modules` had to be restored with `npm ci --ignore-scripts` after the sandbox pruned it. Two scratch worktrees and all probes were removed afterwards.

**Table A — fixed payload per request (bytes, tokens est.)**

| Component | Stage-5 `0e566c0` | Phase 1 `3b3f23a` | HEAD `18d3ee1` |
|---|---|---|---|
| system prompt | 7,621 (~1,905) | 7,688 (~1,922) | 8,175 (~2,044) |
| tool descriptions (14–15 tools) | 6,016 (~1,504) | 5,634 (~1,409) | 5,873 (~1,468) |
| `book` parameters, as sent | **551** (compact projection) | 2,265 (flat) | 2,380 (flat + cursor) |
| **fixed total** (prompt + descriptions + book decl) | **14,188** | **15,587** | **16,428** |
| delta vs Stage-5 | — | +1,399 | **+2,240 (~560 est. tokens)** |

The flat declaration costs ~470 est. tokens per request versus the compact projection, on every request, forever — and buys back the entire transient column:

**Table B — transient cost per cold `book` episode (Stage-5 only; HEAD pays zero)**

| Branch | Injected branch schema | est. tokens |
|---|---|---|
| ledger | 21,747 B | ~5,437 |
| plan | 37,799 B | ~9,450 |
| atlas | 38,492 B | ~9,623 |
| context | 25,919 B | ~6,480 |

Injection happened on the *first* book call of an episode and was re-read by the server until the operation succeeded (up to 3 replay attempts, then a canned failure). One cold `book plan` call at Stage-5 cost the plan branch alone ≈ 9.5k tokens plus ≥ 2 model turns (routing turn, then the reissued call) and 2 stored junk messages (the assistant marker and the `\u2063` continuation). At HEAD the same call costs its fixed bytes in Table A, one model turn, zero stored junk — the §6.9 "~11,000 tokens" worst case is re-measured here at 9.4–9.6k for plan/atlas on this exact tree.

**Table C — Durable reads per `book … list` call** (fake world; `ok: true` on every call)

| call | Phase 1 `3b3f23a` (every call) | HEAD cold (builds memo) | HEAD warm (memo probe) |
|---|---|---|---|
| `message list` | 1 scanConversations + 7 scanEntries | 1 + 7 + 1 scanTasks + 1 NestedCallDoc read | **1 + 2 scanEntries + 1 scanTasks, 0 NestedCallDoc reads** |
| `toolCall list` | 1 + 7 + 1 scanTasks + 1 NestedCallDoc read | served by the just-built memo: 1 + 2 + 1 | **1 + 2 + 1, 0 NestedCallDoc reads** |
| `toolResult list` | 1 + 7 + 1 scanTasks + 1 NestedCallDoc read | served by the just-built memo: 1 + 2 + 1 | **1 + 2 + 1, 0 NestedCallDoc reads** |

Phase 1 re-derived the whole durable world from the transcript on *every* list call — including re-fetching the nested document once per call; HEAD derives once, then pays a constant watermark probe. Point reads (`inspect`/`read` on a known id) use the same memo with a single-entry re-derivation fast path.

**Table D — error-attached guidance (Q3; authorized 2026-11-15 after the dice-roller live run)**

The live 27B Qwen run on this branch failed 3 of its first book calls: an invented `items`-batch op aimed at ledger, the same aimed at plan (`type` instead of `mode`), and a goal add missing `done_when` — all three caught by the local validators (the fail-closed design held), each costing a round trip. `18d3ee1` appends one line to **local failures only**, only for brain targets with opaque `operation` payloads:

```
Op 1 (add) not applied: `mode` is undefined; it is look (the task only reads) or change (the task writes files).
plan add takes: mode (look | change) and text — before, network and standing optional (network/standing only with change).
```

Unsupported `target`/`action` pairs now list the target's supported actions, read from the `CAPABILITIES` table (no hand-written list to drift). Happy-path bytes are unchanged. The `atlas` tool keeps its own world (out of scope for Q3).

**Table E — context block baseline (fixture, fresh brain)**

`stateBlock` on a fresh brain ≈ **828 B** (~207 est. tokens); the standing per-request payload is dominated by Table A, not by state.

**What Phase 3 did not establish** — for Stage 8/live only: first-try success rates of the 27B with the prompt lines (`d2a1666`) and the Q3 guidance; provider-specific serialization; real tokenizer counts; adapter parity. The Stage-5 column of Table A/B is not re-measurable in isolation without the deleted lifecycle, and was not re-measured end-to-end — it is the review-time measurement, reproduced here for the on-wire declaration and the branch injections.

## Appendix G — Q1 decision and atlas fold (2026-11-15, `7571490`)

**Decision (user):** clean fold — the standalone `atlas` tool is deleted; `book target=atlas` is the only door; the verb enumeration is ported into the book description; `tree` stays in the book atlas target for the main agent.

**Accounting correction to Appendix F, Table A:** the atlas tool's declaration (parameters 4,665 B + wrapper keys ≈ 5,043 B, present in all three trees) was omitted from every fixed-total row. Including it, the true fixed payloads were: Stage-5 `0e566c0` ≈ **19,231 B**; Phase 1 `3b3f23a` ≈ **20,630 B**; HEAD at `18d3ee1` ≈ **21,471 B**; after the fold (`7571490`): prompt 8,249 + descriptions 5,606 + book declaration 2,380 = **≈ 16,235 B** — the lowest fixed per-request payload measured, ~3,000 B below the Stage-5 baseline including its atlas declaration. The fold deleted 160 lines (`src/tools/atlas.mjs`) with no engine duplication.

**Implementation notes:** `look` and `tree` verbs were added to book's atlas capability set (`look` takes `operation.name`, a node name or a project path; `tree` takes free-form `anchor`/`depth` and persists its view without marking replay state — main-agent only, as before). The mutation branch's file listing is wired to `projectFiles(root)` so `tree`'s folder check and `link`'s validation work — the first port passed `() => []`, which silently refused every `tree` call and mis-validated `link` files; caught by the offline fold probe. `book` atlas results render through the existing book result chain (`● atlas <change>` lines, routed to the Carto tab); the standalone tool's terminal case and task-call rendering were deleted. `TOOLS.atlas` is gone; the "one call" rewording reaches the collapse/handoff notes as well (`assess`, itself a deleted tool, was named there too).

**Observation, not changed:** crash-replay via `atlas.lastCall === api.taskId` is shared with the ledger/books/plan — a second changing atlas call within the same tool task is reported as "already applied before a restart." That is the designed replay semantics; whether `taskId` is stable per user turn in the live runtime is unverifiable offline and was not altered.

**Not done:** README still describes the Stage-5-era surface in full (tools table, "What has been tried"); Phase 5 will make it honest. The test suite at `cea8468` exercises `atlasTool` directly and needs Phase 4 adaptation. Appendix D's "not yet done" list is superseded by Appendices E–G for items it records.
