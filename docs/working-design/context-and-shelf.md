# Working design: universal references, books, schemas, and collapse memory

**Status:** Stages 0–3 are complete in the current implementation. The user's universal identity and book-operation requirement is now the architectural target; the current shelf/report references are only partial coverage. Broader implementation is paused until the reference model, operation contract, and prerequisites below are resolved. Do not run tests until the final verification stage (now Stage 8).

## Confirmed intent

1. **Give every agent-known entity a usable identity.** Anything the agent can know about or act on—including prompt/system sections, tools and exact schemas, chat messages, tool calls/results, files, and brain records—must have a marker/reference that lets the `book` system identify and resolve it. Define the supported universe and identity lifecycle before expanding resolvers; do not assume every entity can be mutated in the same way.
2. **Adding an item makes it available now and later.** A successful `shelf add` should append a snapshot of the selected entity to active context immediately, and retain it so it is available in organized form after the next collapse. Stage 3 now does this for file/report shelf entries, but it has not yet made shelf a first-class target or extended this behavior to the full entity inventory.
3. **Show pending changes to shelved snapshots.** If a shelved file changes after its snapshot was placed in context, the state block should show a diff for the un-collapsed changes. At collapse, incorporate the update into the reorganized core and reset the comparison baseline.
4. **Load other tool schemas on demand.** A full schema for a tool should be brought into the current context only when that tool is about to be used, rather than keeping every full schema in every request. Keep it available through validation; after a successful call, remove the temporary schema material but retain the successful exact call pattern and result as an example.
5. **Collapse should organize memory, not just trim it.** As a session grows, cluster useful chat and context into structured blocks corresponding to the user's visible areas: chat, atlas, ledger, plan, requests, tree, books, shells, thinking, notes to self, and tool results. Treat the clusters as a loose stack rather than a fixed-order outline: order or regroup by recency, and only reorganize as deeply as needed. Keep the newest tail relatively raw/frayed. Preserve exact information where needed and retain links/provenance so a summary does not replace a source of truth.
6. **Centralize configuration-like values throughout the codebase.** Avoid scattered magic numbers, fixed control words/strings, default choices, thresholds, flags, and toggles; values such as `control: { terminate: true }` in `src/tools/chat.mjs` belong in the central configuration surface. This does not mean mechanically moving ordinary local implementation variables. Preserve behavior while doing the broad configuration sweep.
7. **Use one tagged row model and a shared entries engine.** Preserve composed rows generated from task/tool history and curated rows independently selected and editable as distinct species in one understandable model. The agent and user have the same row operations. Persist operations immediately; `when: now | next-boundary` controls only when the active context reflects them. `now` takes effect after the current safe tool call/round; `next-boundary` takes effect at the next collapse/rebuild. The state block reports pending visibility differences, including additions, edits, and removals. An explicit collapse finishes the current tool call/round safely and starts the next model request from collapsed context. Reports are composed rows referencing separate full-report content, preserving IDs and recall/fold/archive/unarchive/delete behavior without `REPORT`-pattern dispatch in the shared operations layer. Use the shared entries engine for plan CRUD through specs-with-hooks; keep plan authorization logic hand-rolled and separate.

8. **Make `book` the universal, reference-driven operation tool.** `book` is the common interface for working with any supported agent-known entity. The call selects a target/book and a standardized operation; a reference identifies the specific entity. Use shared operation language and behavior where semantics match, with explicit type-specific capabilities rather than inconsistent special workflows or verbs stretched beyond their meaning. The schema is comprehensive because the tool has broad responsibility: preserve descriptions and exact validation behavior, and load the relevant full schema live/on demand rather than stripping useful guidance to make it smaller. Every entity must be resolvable through a shared reference interface; the shelf is a first-class target/operation, not a pair of context-only `shelve`/`unshelve` exceptions. The precise call shape and identity encoding remain open until the contracts below are settled.

## Confirmed direction

- Give every tool and exact schema version its own reference; schema lookup is an operation on those references. Keep the universal `book` contract/schema available, and load the selected entity/action's relevant full schema when needed. Do not frame shelf as a separate special tool with its own isolated schema.
- For a selected tool, make its precise full schema available both in the active context and in the provider-facing `tools` payload for that request. Validate the resulting call locally as well. After a successful call, remove the temporary schema material from subsequent context and retain the successful exact call pattern and result as an example. This is intended to make complex calls more reliable while keeping the ordinary prompt small; local validation still does not guarantee the model will initially generate a valid call.
- Use one universal typed-reference catalog, with shared resolvers for files, reports, schemas, messages, tool calls/results, prompt content, and other agreed entities. `book` operations act on those references through one capability-aware contract; shelf is a first-class way to keep references and their resolved snapshots in view, not a separate per-kind workflow. A schema reference resolves to the exact schema version/content used; report references retain links to their separate full bodies.
- Persistent file snapshots and shelved schema lookups count against the existing `shelfTokens` cap. A schema loaded temporarily for a tool call does not count as persistent shelf content. Reserve enough working-context room for the largest full tool schema; the current expectation is that normal collapse will happen before that headroom is exhausted, but this needs to be checked against the actual context-budget behavior during implementation.
- For an incomplete or invalid submission, return a clear, actionable error and rely on the model to recover; do not design a separate recovery workflow in advance. The user will report concrete failure modes if this proves insufficient.
- Reframe `task` as a self-steering branch of the same agent, not delegation to another mind. The fork already retains the prior conversation and prompt; the explicit text brief should be optional and, when present, act as a short steering/persona cue rather than a replacement for that context. The task still obeys its mode/plan gates and returns a report.

## Universal reference and `book` contract

The user has clarified that universality is the architectural goal, not a prompt-size optimization or a shelf-only feature:

- Every entity the agent can know about needs a marker/reference. The named scope includes system-prompt content, each tool and exact schema, chat messages, tool calls and results, all files, and the brain's own entities. The entity inventory must define any additional runtime or external kinds before claiming coverage.
- The top-level `book` tool selects what kind of book/target is being operated on; the operation then acts on a specific referenced entity. The desired mental model includes calls such as `book plan add ...` and `book shelf remove ...`. Current JSON shape is not that model: `book` currently selects only `ledger | plan | books | context`, and shelf mutations are `shelve`/`unshelve` actions inside `book: context`.
- All supported entities must be addressable and operable through the common `book` system. Operations share names and semantics where appropriate; their capability matrix must say which operations each kind supports, with type-aware validation and errors. This does not imply unsafe or nonsensical mutations, nor does it bypass the existing plan, approval, sandbox, or main-agent/task authority gates.
- References must resolve to the exact source/entity/version they name and preserve provenance. A file path, a file snapshot, a line-range snapshot, and a particular schema version may need distinct identities; settle that identity contract before treating any resolver as universal.
- The full schema and its descriptions are part of the tool's guidance and validation contract. Do not optimize away useful wording merely to shorten the prompt. Confirm what compile/provider layers preserve, and expose the schema relevant to the selected operation without losing local validation.

This requirement supersedes the earlier incremental framing that treated universal shelf resolution as a long-term extension of a file/report shelf. Stages 2–3 remain completed work within their narrower scope, but their current IDs/references do **not** satisfy universal identity or universal book operations. Do not present them as having done so.

## Current behavior observed

- `book` is the top-level tool, but its `book` argument currently selects only `ledger`, `plan`, `books`, or `context`; `ops[].action` is the verb. Shelf is not a first-class selectable target: it is exposed as context `shelve`/`unshelve` actions, and shelf entries are identified by path/reference or `all`, not a universal item ID.
- Stages 2–3 introduced tagged composed/curated rows and typed, snapshotted file/report shelf entries. Shelf additions now put their snapshot in active context, and pending file changes appear as diffs. These are partial reference implementations, not a namespace or ID/resolver catalog covering prompts, schemas, messages, tool calls/results, and all files.
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

## Questions and decisions required before universal implementation

These are design questions, not settled behavior. Resolve them before implementing the universal reference layer; do not let a convenient first resolver silently decide them.

### Identity and scope

- What is the exact entity universe for the first complete catalog? The user explicitly named system-prompt content, tools and exact schemas, every chat message and tool call/result, and all files; decide how this includes directories, ranges, generated artifacts, binary/unreadable files, runtime state, external resources, and entities created later.
- What does a “marker” mean in storage: an ID in an external registry/index, metadata attached to persisted records, an in-band marker in source content, or a combination? Do not mutate project files or prompt content to insert markers without an explicit design decision.
- Are IDs opaque and allocated, deterministic from a namespace/path, or derived from content? How do IDs behave across file moves/renames, copies, duplicate content, edits, deletion/recreation, schema changes, prompt revisions, and conversation restarts? Distinguish stable entity identity from exact immutable version/snapshot identity where needed.
- What guarantees are available for provider message/tool-call IDs across forks, retries, and durable restarts? If those IDs are not durable or globally unique, what local IDs and provenance links are assigned?
- Which sources are authoritative, and which are snapshots, projections, summaries, or generated views? A reference must make clear whether it resolves to live content or an exact historical version.

### `book` interface and operations

- What exact target grammar expresses the desired model (`book shelf add`, `book plan add`, etc.) in the actual tool-call schema? Is `shelf` a first-class book, and do other entity kinds become books or typed targets selected by reference?
- What is the stable `id` used by `shelf remove <id>`? How is an item ID related to its target entity ID, version, and shelf placement? Define update/replace, duplicate-add, remove-one, and remove-all behavior.
- What is the shared operation vocabulary and capability matrix by entity kind? Specify which operations are universal (for example inspect, add/link, edit, remove/archive/restore) and which are valid only for particular types. Keep distinct meanings distinct; do not force every verb onto every type.
- Does `book` directly mutate files, prompt sections, schemas, messages, and tool-call records, or does it identify/prepare them while existing write tools and plan/approval gates perform mutations? Define authorization, immutability, and confirmation requirements per target kind.
- What are the atomicity and batch semantics for `ops`: all-or-nothing or per-operation results, how partial failures are reported, and how concurrent main/task changes are reconciled?
- Must terminal, screen, agent, and task interfaces call the same operation implementation and expose the same capability/authorization contract?

### Resolution, schema, and context behavior

- What resolver contract returns identity, type, live content, exact version, provenance, and supported operations? How are unresolved, stale, deleted, inaccessible, or oversized targets represented without losing their references?
- How are tool schemas and prompt content versioned and resolved byte-for-byte? Confirm by inspecting the installed `pi-schema` and `pi-durable` code and tracing the actual provider payload whether descriptions/conditionals survive compilation and transport; also establish how dynamic schemas coexist with local validation and durable call replay.
- What is the maximum schema/reference footprint, what exact headroom must be reserved, and what deterministic collapse/deferral policy prevents the selected schema plus current conversation from exceeding the context window?
- Which entities are persistent shelf content and charged to `shelfTokens`, which are temporary schema/context material, and how are snapshots, versions, diffs, and references charged without double-counting or dropping existing data?
- Which information remains verbatim through collapse, and which can be summarized with a provenance link back to its exact source? What are the durable clusters and recency rules?

### Migration, safety, and acceptance

- How are current file-path shelf items, report references, composed/curated rows, plan entries, chat histories, and task state migrated to the identity model? What must remain readable by old data and old sessions during migration?
- How are IDs protected from path traversal, forged schema references, stale-version writes, and authorization bypass? Preserve the main-agent/task, plan, approval, sandbox, and network gates independently of the common operation engine.
- What acceptance criteria prove complete coverage of the agreed entity inventory, stable identity/version behavior, type-appropriate operations, provenance, persistence, migrations, provider-facing schema correctness, token-budget safety, and actionable errors? Tests may be prepared during implementation but remain unrun until final verification.

## Prerequisites / implementation gates

Before building the universal layer, complete and review these prerequisites:

1. Agree on the entity inventory and what “marker” means; write down identity, version, and lifecycle rules, including file moves, edits, deletion/recreation, and ephemeral conversation objects.
2. Specify one reference/resolver contract and a typed capability/authorization matrix, including the exact `book` target grammar and shelf item IDs.
3. Inventory authoritative storage and migration paths for every initial entity kind; design durable ID/index persistence and provenance links without modifying source content by accident.
4. Trace the installed schema/provider implementation end to end, preserving useful schema descriptions and local validation; define exact schema versioning and safe dynamic-payload behavior.
5. Calculate context and persistent-shelf budgets using largest full schema/content and pending diffs; define deterministic reservation/collapse behavior before adding more live schema material.
6. Define cross-interface operation semantics and failure/batch behavior, and prepare acceptance coverage for the agreed universe before implementation proceeds.

Stage 2’s completed decisions remain valid within their scope: tagged composed/curated rows, shared entry operations, immediate persistence with visibility timing, separate report bodies, safe-boundary collapse, and plan-specific authorization outside generic CRUD. They do not settle universal IDs or universal target coverage.

## Proposed staged implementation plan

Implementation of the universal expansion is **not authorized until the prerequisites above are resolved**. Once authorized, keep stages sequenced and add/update acceptance tests with the code, but **do not run tests until final verification (Stage 8)**. Inspect the live diff before editing and avoid overwriting or attributing existing changes to this feature.

### Stage 0 — initial implementation audit (complete; universal-contract follow-up remains)

- The earlier audit traced context budgeting/collapse triggers and the installed provider request/argument hooks; findings are recorded above.
- Stage 1–3 implementation and their narrower acceptance assertions are recorded below. The new universal reference requirement exceeds that audit's original scope.
- The universal entity inventory, ID/version lifecycle, `book` target grammar, capability/authorization matrix, migration, and complete acceptance contract are unresolved gates for Stage 4; do not infer them from the earlier file/report shelf.

**Exit for the original audit:** provider and budget observations were recorded. **Not an exit for universal implementation:** the newly surfaced contracts remain open.

### Stage 1 — centralize configuration and remove magic values

- Extract configuration-like constants and toggles throughout the codebase into the central configuration surface (currently `src/config.mjs`, with domain grouping if needed for maintainability).
- Avoid scattered magic numbers and words: centralize defaults, thresholds, limits, fixed control strings/enums, sentinel values, and boolean control options. This includes values embedded in tool definitions and behavior such as `control: { terminate: true }` in `src/tools/chat.mjs`.
- Keep ordinary local variables local; the target is values that define behavior/configuration, not a mechanical relocation of every implementation variable. Preserve behavior while centralizing and document any intentionally local exceptions.
- Update or add regression tests, but do not execute them before Stage 8.

**Exit:** a reviewed inventory shows behavior/configuration values are centralized, with no unexplained magic values left in the codebase; test coverage is prepared but not yet run.

**Stage 1 inventory (complete, 2026-11-13):** `src/config.mjs` exports deeply frozen `DEFAULTS` and `POLICY`. The reviewed inventory covers domain limits and output caps; timings and retry/refresh cadence; formatting thresholds; config/schema validation bounds; tool-definition bounds; fixed action, mode, kind, lifecycle, wake, window, color/theme, and replay enums; ID patterns and generation prefixes; markup tags; control options and messages; and sentinels. Consumers have been redirected across persistence/domain code, tools and harness, terminal, state construction, and screen models. This includes provider ask-request flags/options, shell actions, atlas actions, shared entry actions/statuses, wake kinds, all shell-window states and wait reasons, and the generated ID forms. Screen coverage includes refresh/spinner cadence, clipboard/output caps, live chat/list limits, shell views, wheel scrolling, and interaction timers. Regression coverage asserts deep immutability of defaults and nested policy collections; it has not been run.

**Reviewed intentional local values (not unexplained policy):** arithmetic and unit conversions (seconds/minutes/hours to milliseconds), indexing/iteration offsets, 0/1 empty/count sentinels, and hash/fingerprint truncation widths stay with their algorithms. ANSI/terminal input and shell prompt protocol sequences remain paired with their parser/writer; terminal geometry, text wrapping, palette values, color-space constants, and compact view layout thresholds remain with the presentation algorithms. Each JSON store's `version: 1` and its filename remain in the owning persistence module because they are per-format storage contracts, not shared runtime policy. Help examples and prose labels are descriptive text, not executable control values. The final inventory found no unexplained tool-schema bounds, replay/control literals, duplicated domain lifecycle enums, or behavior-facing thresholds among the reviewed source literals. Syntax checks for changed `.mjs` modules, `git diff --check`, and a scan verifying every referenced `POLICY`/`DEFAULTS` path resolves passed; tests remain intentionally deferred to Stage 8.

### Stage 2 — curated rows and shared entry operations

- Model composed and curated rows as explicit species in a shared tagged representation, with content provenance/source references preserved.
- Give the agent and user the same operation capabilities; enforce the shared contract in the API.
- Persist every operation immediately. Make `when: now | next-boundary` govern only when the active context reflects additions, edits, archives, or deletes; report pending differences in the state block until a context rebuild catches up.
- Make collapse explicit and safe at the current round boundary; the next model request starts from the collapsed context.
- Bring reports into the composed-row model while retaining stable IDs and separate full-report content; remove report-ID-pattern special cases from shared row operations. Preserve recall, fold, archive, unarchive, and delete semantics. The shelf resolves report references to full content when requested and within its cap.
- Use the shared entries engine for plan CRUD via specs-with-hooks, while keeping plan-specific authorization hand-rolled and separate from generic CRUD.
- Keep `book` as the intended universal, standardized interface. Its schema and other operation schemas should be available live/on demand where useful; do not fragment standardized operations into inconsistent special tools. Stages 2–3 implemented only shared rows and initial shelf resolvers; Stage 4 now defines the missing universal-reference/catalog work.
- Add or update acceptance tests for both row species, equal audience capabilities, visibility timing, collapse, report operations, and plan CRUD; do not run them until Stage 8.

**Progress (2026-11-13):** plan add/edit/done/remove use `src/rows.mjs` through a plan-specific spec; authorization transitions and collection-level `clear` remain in `src/plan.mjs`. Composed reports and curated rows now share the tagged context collection, with curated CRUD using the same entries engine and user/agent row actions routed through the same context API. Visibility snapshots track targeted now/next-boundary changes without flushing unrelated pending rows; state reports additions, edits, archives, deletes, and reorderings. Reports retain separate body files and resolve through typed shelf references. Acceptance assertions cover plan placement, curated visibility, and full report shelf resolution. Earlier full-suite validation completed with `npm test`: 161 passed, 0 failed, 5 skipped because bubblewrap is not installed (this records prior work; do not treat it as validation of the new universal-reference scope).

**Exit:** context rows share one tagged representation with both species preserved; report operations resolve through row species rather than ID-prefix dispatch; plan CRUD uses the entries engine while authorization remains distinct; pending active-context differences are explicit in state.

### Stage 3 — typed shelf and immediate file snapshots

- The completed incremental Stage 3 retained existing `book` entry points and conditional validation. That compatibility choice is now historical; Stage 4's universal `book` target/operation contract supersedes the `shelve`/`unshelve` entry points.
- Make a successful file add (whole file or selected range) append its current snapshot to active context immediately and persist it for collapse.
- Account persistent snapshots against `shelfTokens`; report an actionable error for unreadable files, invalid ranges, or over-cap adds. Do not silently lose existing shelf data.
- Expose pending file changes as a diff in the state block; at collapse, incorporate the current contents and reset the comparison baseline.
- Add or update focused tests without running them yet.

**Progress (2026-11-13):** shelf items now carry explicit `file`/`reference` types and persisted snapshots (legacy path/reference entries are normalized when read). Successful book, user, and task shelf additions place the exact snapshot in active context immediately; task handoffs carry that snapshot too. Persistent snapshot sizes are charged to `shelfTokens`, while over-cap adds leave the prior shelf untouched. The state block shows pending snapshot changes as a bounded line diff, and collapse refreshes the baseline from current content. Focused acceptance assertions cover immediate visibility, range snapshots, capacity/error cases, task handoff, diffs, deletion, and reset at collapse. Syntax checks and `git diff --check` passed; tests were intentionally not run per instruction. These are typed shelf records, not universal stable IDs or a reference catalog for the other entity kinds.

**Exit:** test coverage addresses immediate visibility, persistence through collapse, ranges, cap accounting, diffs, updates/deletions, and failure behavior.

### Stage 4 — universal reference catalog and `book` operations (design gate; not yet authorized)

This is the next architectural stage. Do not begin implementation until the prerequisites and questions above have explicit decisions.

- Define and implement the first agreed entity catalog: stable marker/reference IDs, entity type, source of truth, version/snapshot identity, provenance, lifecycle, and resolver for each supported kind (including prompt/system content, tools/schemas, chat messages, tool calls/results, files, and brain entities).
- Establish whether markers live in an index/metadata or in-band; keep user/source content unchanged unless that is explicitly chosen.
- Make `book` select and operate on all agreed targets through one API/schema. Represent shelf as a first-class selectable target with standardized `add`/`remove` operations and a stable shelf-item identity; remove the current context-only `shelve`/`unshelve` model without losing migration compatibility.
- Define a shared operation vocabulary and per-type capability specification that drives descriptions, validation, implementation, and actionable unsupported-operation errors. Similar operations must behave consistently; type-specific actions remain explicit.
- Preserve plan, approval, sandbox, network, and main-agent/task authority gates for any operation that changes protected content. All interfaces (agent, task, terminal, screen) use the same operation implementation and authorization contract where applicable.
- Migrate existing path-based shelf items, report references, row IDs, and persisted context safely; retain old data and provenance.
- Add acceptance coverage for the initial entity inventory, stable identity/versioning, resolution, operation matrix, migrations, capability errors, and authorization. Do not run tests yet.

**Exit:** every entity in the agreed initial inventory has a stable, resolvable reference; the `book` schema and execution path can perform every operation allowed by its capability contract, including `book shelf add/remove`; persisted data migrates without loss; authorization remains intact. Unsupported entity kinds are explicit, not silently absent.

### Stage 5 — on-demand tool-schema lifecycle

- Treat each tool and exact schema version as a first-class referenced entity under Stage 4's identity contract. Keep the `book` schema available; load another full schema on demand when that tool is about to be used.
- When a selected tool is used, place its exact schema in active context and send it as the provider-facing schema for that request; leave unrelated schemas compact.
- Preserve useful descriptions and conditionals. Confirm compile/provider transport behavior from the installed dependencies, and locally validate before execution. On success, remove temporary schema material from subsequent context and retain the successful exact call and result as a referenced example. On invalid calls, return a useful error and keep enough schema context for a retry.
- Reserve and account for schema headroom under the established context-budget policy; persistent schema references count against the shelf cap, one-use schema material does not.
- Add or update focused tests without running them yet.

**Exit:** acceptance coverage addresses provider payload selection, exact schema identity, validation-before-execution, cleanup/retention on success, retry behavior on failure, and persistent versus temporary token accounting.

### Stage 6 — structured, loose-stack collapse memory

- Evolve collapse from fixed front-block sections into user-area clusters (chat, atlas, ledger, plan, requests, tree, books, shells, thinking, notes to self, tool results).
- Keep clusters reorderable by recency and reorganize only as deeply as needed; let the newest tail remain relatively raw.
- Preserve provenance and access to original conversation/reports; do not turn uncertain summaries into facts or discard exact details needed for reliable tool calls.
- Add or update focused tests without running them yet.

**Exit:** test coverage addresses cluster organization, recency/reorganization, raw recent tail, source/provenance retention, and shelf/diff integration.

### Stage 7 — same-agent task framing

- Change the task prompt from subagent/delegation framing to a continuing self-steering fork of the same agent.
- Make the text brief optional; when present, it is a concise steering/persona cue, not a replacement for retained context.
- Preserve task authority, mode, plan, approval, sandbox, and return/report gates.
- Add or update focused tests without running them yet.

**Exit:** test coverage addresses optional brief behavior and unchanged authority boundaries.

### Stage 8 — final verification and documentation

- Run the prepared focused tests and full suite only now; document environment-dependent skips and any remaining caveats. Fix failures, then rerun the necessary verification.
- Review the combined diff specifically for compatibility with existing branch changes, centralized configuration, token-budget behavior, and regressions in tool authorization.
- Verify universal completion against the agreed full entity universe, not only the first rollout: every in-scope entity kind has a stable resolvable identity, a documented capability/authorization contract, and access through `book`; any scope boundary is an explicit user decision, not an implementation omission.

## Guardrails to preserve

- Keep the original conversation and reports available for recall; a summary is a navigable memory layer, not destructive deletion.
- Keep change authorization and project-write restrictions independent of context/shelf behavior.
- Validate shelf item types and bounds; never let a schema reference or file path bypass normal tool checks.
- Mark which requirements are user decisions versus model-generated summaries, and avoid turning uncertain summaries into facts.
