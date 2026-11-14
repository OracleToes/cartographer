# Working design: shelf, on-demand schemas, and collapse memory

**Status:** implementation authorized. Stage 0 audit and Stage 1 configuration centralization are complete. No tests are to be run until final verification (now Stage 7). The curated-row/shared-entries-engine workstream is also part of scope and is tracked below.

## Confirmed intent

1. **Make the shelf a distinct, typed concept.** A shelf can hold a project file (or a selected line range), and should be extensible to other useful references. The shelf's own full schema should remain available because other tool workflows depend on it.
2. **Adding an item makes it available now and later.** A successful `shelf add` should append a snapshot of the selected file contents to the active working context immediately, and retain it so it is available in organized form after the next collapse. The current main-agent file-shelf operation only marks it for the next collapse; that is not the desired behavior.
3. **Show pending changes to shelved snapshots.** If a shelved file changes after its snapshot was placed in context, the state block should show a diff for the un-collapsed changes. At collapse, incorporate the update into the reorganized core and reset the comparison baseline.
4. **Load other tool schemas on demand.** A full schema for a tool should be brought into the current context only when that tool is about to be used, rather than keeping every full schema in every request. Keep it available through validation; after a successful call, remove the temporary schema material but retain the successful exact call pattern and result as an example.
5. **Collapse should organize memory, not just trim it.** As a session grows, cluster useful chat and context into structured blocks corresponding to the user's visible areas: chat, atlas, ledger, plan, requests, tree, books, shells, thinking, notes to self, and tool results. Treat the clusters as a loose stack rather than a fixed-order outline: order or regroup by recency, and only reorganize as deeply as needed. Keep the newest tail relatively raw/frayed. Preserve exact information where needed and retain links/provenance so a summary does not replace a source of truth.
6. **Centralize configuration-like values throughout the codebase.** Avoid scattered magic numbers, fixed control words/strings, default choices, thresholds, flags, and toggles; values such as `control: { terminate: true }` in `src/tools/chat.mjs` belong in the central configuration surface. This does not mean mechanically moving ordinary local implementation variables. Preserve behavior while doing the broad configuration sweep.
7. **Integrate the curated-row and shared entries-engine design.** Context has two row species: composed entries, generated from task/tool history (for example, a report plus metadata), and curated rows, independently selected and editable. An estimated 250–350 token saving is unverified. Give verbs per audience and row: the agent may fold/recall; the user alone may archive/delete. `when: now | next-boundary` controls context visibility, not whether the underlying operation is persisted: persist the row operation immediately; `now` inserts its contents into active context immediately, while `next-boundary` makes it available at the next collapse/boundary. Collapse is an action; `now` means finish the current tool call/round safely and start the next model request from the collapsed context. Dissolve the `REPORT` special case in `ops.mjs`. Use the entries engine for plan CRUD via specs-with-hooks, while keeping authorization logic hand-rolled and separate.

## Confirmed direction

- Make schema lookups shelfable references, e.g. a stable ID for a particular tool/action schema. The shelf always exposes its own full schema. Other tools' full schemas are loaded only when that tool is about to be used.
- For a selected tool, make its precise full schema available both in the active context and in the provider-facing `tools` payload for that request. Validate the resulting call locally as well. After a successful call, remove the temporary schema material from subsequent context and retain the successful exact call pattern and result as an example. This is intended to make complex calls more reliable while keeping the ordinary prompt small; local validation still does not guarantee the model will initially generate a valid call.
- Use one typed shelf mechanism for files and schema references, rather than a special workflow for each kind. A schema reference must resolve to the exact schema version/content used.
- Persistent file snapshots and shelved schema lookups count against the existing `shelfTokens` cap. A schema loaded temporarily for a tool call does not count as persistent shelf content. Reserve enough working-context room for the largest full tool schema; the current expectation is that normal collapse will happen before that headroom is exhausted, but this needs to be checked against the actual context-budget behavior during implementation.
- For an incomplete or invalid submission, return a clear, actionable error and rely on the model to recover; do not design a separate recovery workflow in advance. The user will report concrete failure modes if this proves insufficient.
- Reframe `task` as a self-steering branch of the same agent, not delegation to another mind. The fork already retains the prior conversation and prompt; the explicit text brief should be optional and, when present, act as a short steering/persona cue rather than a replacement for that context. The task still obeys its mode/plan gates and returns a report.

## Current behavior observed

- The main agent's `book` context `shelve` operation stores a file path/range but explicitly says the main context is unchanged until the next collapse. The next collapse reads the file and places it in the front block. Tasks have their own shelf state; a task can hand an item to the main agent on return.
- The collapse front block has fixed sections for finished-task records, shelf contents, and the most recent chat up to `chatWindow`. It does not currently cluster older chat into topic/decision summaries.
- **Stage 0 budget trace:** the main and task contexts use `contextWindow * collapseFull / 100` (default 80%) as a near-full trigger, based on the server's reported usage after a response. `engine.sizes()` separately reports a fixed estimate for tool definitions plus the system prompt, but the trigger does not reserve explicit space for a temporarily expanded tool schema. Thus collapse-before-overflow is not yet a guarantee.
- **Stage 0 provider trace:** `openSession()` builds one fixed `wordingTools` list shared by the main agent and task forks. In the installed `@earendil-works/pi-durable` 1.5.2 API, `beforeProviderRequest` is a replacement hook over the provider-specific payload, so it can change the outgoing tool schema for one request without changing the registered tool list. `prepareArguments` runs before ordinary schema validation and execution, so a selected full schema can be checked locally there; retain the existing schema validation afterward. The dynamic payload still changes the provider prompt prefix and needs careful token/prefix handling.
- **Stage 0 collapse finding:** the threshold is based on server-reported usage from a prior response. It does not prove that the next request—especially one with a larger schema—will fit. The maximum schema footprint and a deterministic reservation/trigger policy remain to be calculated in implementation.
- **Stage 0 configuration inventory:** behavior-defining values are distributed across central defaults and many modules, including limits, timing values, schema bounds/enums, fixed control strings, and tool control/replay settings; `terminate: true` appears in several tool/harness paths. The sweep is broader than numeric literals and needs a deliberate migration map. Tests have not been run, per instruction.

## Current agent gates

- The main agent coordinates but cannot call project `read`, `search`, `list`, `write`, `edit`, or `shell` directly; those are refused before execution. It uses tasks for project work.
- A task **does not always need a plan item**. If `task` is called without `item`, it is a read-only look task (`read`, `search`, `list`) and needs no plan or approval.
- A task with an `item` must name an existing open plan item. A `look` item needs no approval and remains read-only. A `change` item is refused until authorized.
- By default, approval is on (`yolo: false`) and command sandboxing is on (`bwrap: true`). `/approve p2` approves a specific waiting request; `/approve` authorizes the open change items in the plan as it stands. `/yolo on` bypasses approval while the process runs, but does not remove the plan-item requirement. `/yolo off` restores approval.
- Approval and sandboxing are separate gates. `/bwrap` or `--no-bwrap` controls command sandboxing; a plan item's `network` mark controls whether its change task may use network access in the sandbox. The configured runner may also run commands directly or refuse them if sandboxing is unavailable.
- Tasks cannot start other tasks. The main agent owns plan, ledger, prompt, and project-book writes; tasks may use context operations and return a report.

## Open design questions

- What exact shelf commands and syntax should the agent see? Should the existing unified `book` remain the single public tool? Preserve conditional validation.
- For plan CRUD on the shared entries engine, should the engine own only row CRUD (add/edit/done/remove/reorder), while plan authorization remains hand-rolled? This needs discussion before Stage 2.
- What are the durable collapse clusters (for example: goal/acceptance criteria, decisions, findings, open questions, successful call patterns, and shelf index)? Which information must remain verbatim?
- How should schema references resolve and remain tied to the exact schema version/content used?
- How much context headroom does the largest full tool schema require, and does normal collapse reliably occur before that headroom is consumed?
- What should happen when a persistent shelf add exceeds `shelfTokens`? Persistent snapshots and shelved schema lookups count against the cap; one-use schemas do not.

## Proposed staged implementation plan

This is a sequencing proposal, not authorization to start implementation. Review each stage before moving to the next. Add or update tests alongside the code they cover, but **do not run tests until the final verification stage** because the suite is too slow for repeated runs. Because the current checkout already contains substantial unrelated modifications, first inspect the live diff and avoid overwriting or attributing existing changes to this feature.

### Stage 0 — verify constraints and define contracts

- Inventory the codebase's configuration-like values and trace the actual request/context budgeting and collapse triggers. Establish the maximum temporary tool-schema footprint and whether collapse reliably leaves room for it.
- Trace how provider tool definitions are built and tool calls are validated, executed, and returned, including whether the selected full schema can be sent for one request without changing unrelated tool behavior.
- Specify the typed shelf entry forms, schema identity/version resolution, file/range snapshot behavior, and over-cap/error behavior. Keep the existing unified `book` tool and conditional validation unless evidence requires a separate design review.
- Define acceptance tests for the contracts, including composed versus curated rows and the authorization boundary around shared entry operations, but defer running all tests until Stage 7.

**Exit:** implementation constraints and acceptance criteria are clear; no unresolved provider, budget, or configuration assumption is being treated as fact.

### Stage 1 — centralize configuration and remove magic values

- Extract configuration-like constants and toggles throughout the codebase into the central configuration surface (currently `src/config.mjs`, with domain grouping if needed for maintainability).
- Avoid scattered magic numbers and words: centralize defaults, thresholds, limits, fixed control strings/enums, sentinel values, and boolean control options. This includes values embedded in tool definitions and behavior such as `control: { terminate: true }` in `src/tools/chat.mjs`.
- Keep ordinary local variables local; the target is values that define behavior/configuration, not a mechanical relocation of every implementation variable. Preserve behavior while centralizing and document any intentionally local exceptions.
- Update or add regression tests, but do not execute them before Stage 7.

**Exit:** a reviewed inventory shows behavior/configuration values are centralized, with no unexplained magic values left in the codebase; test coverage is prepared but not yet run.

**Stage 1 inventory (complete, 2026-11-13):** `src/config.mjs` exports deeply frozen `DEFAULTS` and `POLICY`. The reviewed inventory covers domain limits and output caps; timings and retry/refresh cadence; formatting thresholds; config/schema validation bounds; tool-definition bounds; fixed action, mode, kind, lifecycle, wake, window, color/theme, and replay enums; ID patterns and generation prefixes; markup tags; control options and messages; and sentinels. Consumers have been redirected across persistence/domain code, tools and harness, terminal, state construction, and screen models. This includes provider ask-request flags/options, shell actions, atlas actions, shared entry actions/statuses, wake kinds, all shell-window states and wait reasons, and the generated ID forms. Screen coverage includes refresh/spinner cadence, clipboard/output caps, live chat/list limits, shell views, wheel scrolling, and interaction timers. Regression coverage asserts deep immutability of defaults and nested policy collections; it has not been run.

**Reviewed intentional local values (not unexplained policy):** arithmetic and unit conversions (seconds/minutes/hours to milliseconds), indexing/iteration offsets, 0/1 empty/count sentinels, and hash/fingerprint truncation widths stay with their algorithms. ANSI/terminal input and shell prompt protocol sequences remain paired with their parser/writer; terminal geometry, text wrapping, palette values, color-space constants, and compact view layout thresholds remain with the presentation algorithms. Each JSON store's `version: 1` and its filename remain in the owning persistence module because they are per-format storage contracts, not shared runtime policy. Help examples and prose labels are descriptive text, not executable control values. The final inventory found no unexplained tool-schema bounds, replay/control literals, duplicated domain lifecycle enums, or behavior-facing thresholds among the reviewed source literals. Syntax checks for changed `.mjs` modules, `git diff --check`, and a scan verifying every referenced `POLICY`/`DEFAULTS` path resolves passed; tests remain intentionally deferred to Stage 7.

### Stage 2 — curated rows and shared entry operations

- Model the two context row species explicitly: composed entries generated from task/tool history (e.g. a report plus metadata), and independently selected/editable curated rows. Measure the proposed 250–350 token saving rather than treating it as guaranteed.
- Make each row's allowed operations audience-specific: the agent may fold/recall; the user alone may archive/delete. Keep those authority boundaries enforced in the API, not only in UI affordances.
- `when: now | next-boundary` controls context visibility; persist the underlying row operation immediately. `now` inserts the row into active context immediately; `next-boundary` makes it visible at the next collapse/boundary.
- Make collapse an explicit action. For the main agent, `when: now` means finish the current tool call/round safely, then start the next model request from the collapsed context.
- Dissolve the `REPORT` special case in `ops.mjs` by bringing reports into the shared row/operation model without losing report recall, fold, archive, or delete semantics.
- Use the shared entries engine for plan CRUD through specs-with-hooks, while keeping plan authorization logic hand-rolled and separate from generic CRUD.
- Add or update acceptance tests for both row species, audience restrictions, timing, collapse, report operations, and plan CRUD; do not run them until Stage 7.

**Exit:** context rows share one understandable representation with the two species preserved; report operations no longer need a `REPORT` dispatch branch; plan CRUD uses the entries engine while authorization tests and code remain distinct.

### Stage 3 — typed shelf and immediate file snapshots

- Implement the typed shelf representation while preserving current `book` entry points and conditional validation.
- Make a successful file add (whole file or selected range) append its current snapshot to active context immediately and persist it for collapse.
- Account persistent snapshots against `shelfTokens`; report an actionable error for unreadable files, invalid ranges, or over-cap adds. Do not silently lose existing shelf data.
- Expose pending file changes as a diff in the state block; at collapse, incorporate the current contents and reset the comparison baseline.
- Add or update focused tests without running them yet.

**Exit:** test coverage addresses immediate visibility, persistence through collapse, ranges, cap accounting, diffs, updates/deletions, and failure behavior.

### Stage 4 — on-demand tool-schema lifecycle

- Keep the shelf's own full schema available. Add shelfable references to exact full tool schemas, with stable resolution/versioning and persistent lookup accounting under `shelfTokens`.
- When a selected tool is used, place its exact schema in active context and send it as the provider-facing schema for that request; leave unrelated schemas compact.
- Validate before execution. On success, remove temporary schema material from subsequent context and retain the exact successful call and result as an example. On invalid calls, return a useful error and keep enough schema context for a retry.
- Add or update focused tests without running them yet.

**Exit:** test coverage addresses provider payload selection, exact schema identity, validation-before-execution, cleanup/retention on success, retry behavior on failure, and persistent versus temporary token accounting.

### Stage 5 — structured, loose-stack collapse memory

- Evolve collapse from fixed front-block sections into user-area clusters (chat, atlas, ledger, plan, requests, tree, books, shells, thinking, notes to self, tool results).
- Keep clusters reorderable by recency and reorganize only as deeply as needed; let the newest tail remain relatively raw.
- Preserve provenance and access to original conversation/reports; do not turn uncertain summaries into facts or discard exact details needed for reliable tool calls.
- Add or update focused tests without running them yet.

**Exit:** test coverage addresses cluster organization, recency/reorganization, raw recent tail, source/provenance retention, and shelf/diff integration.

### Stage 6 — same-agent task framing

- Change the task prompt from subagent/delegation framing to a continuing self-steering fork of the same agent.
- Make the text brief optional; when present, it is a concise steering/persona cue, not a replacement for retained context.
- Preserve task authority, mode, plan, approval, sandbox, and return/report gates.
- Add or update focused tests without running them yet.

**Exit:** test coverage addresses optional brief behavior and unchanged authority boundaries.

### Stage 7 — final verification and documentation

- Run the prepared focused tests and full suite only now; document environment-dependent skips and any remaining caveats. Fix failures, then rerun the necessary verification.
- Review the combined diff specifically for compatibility with existing branch changes, centralized configuration, token-budget behavior, and regressions in tool authorization.

## Guardrails to preserve

- Keep the original conversation and reports available for recall; a summary is a navigable memory layer, not destructive deletion.
- Keep change authorization and project-write restrictions independent of context/shelf behavior.
- Validate shelf item types and bounds; never let a schema reference or file path bypass normal tool checks.
- Mark which requirements are user decisions versus model-generated summaries, and avoid turning uncertain summaries into facts.
