# Cartographer consolidation plan

**Status:** approved direction and migration design only — no runtime behavior changes in this document.
**Date:** 2026-11-16

Cartographer should have one coherent bounded-deliberation feature: the same-model
`consult` conference described in `docs/consult-mode-proposal.md`. This plan replaces
the former Case/E1 delivery track. Git history and archived records retain evidence of
previous work; they do not make old concepts permanent product commitments.

## 1. Product decision

The end state is deliberately small:

- `consult` is one isolated same-model conference with a caller-supplied `myPersona`,
  contextual book personas, immutable entry-time sources, restricted snapshot tools,
  a grammar-constrained neutral selector, and `consult_return`.
- The separate external-model/`thread` consultation lane is retired. There is no
  Mythos-nano configuration, external-model fallback, or second meaning of `consult`.
- The separate `case` product is retired. Its C1–C3 implementation is not promoted
  into a general framework; C4 isolated scratch and E1 benchmark/escalation policy are
  dropped.
- The conference keeps only the source-capture properties it needs. It does not acquire
  Case capsules, blind/cross phases, witness dockets, artifacts, votes, or scratch
  execution under new names.
- Existing user records are preserved through an explicit archive migration, not by
  keeping a permanent compatibility runtime.

This is a consolidation, not an invitation to add a generic persona, snapshot,
decision, sandbox, or archival framework before a concrete surviving need exists.

## 2. Boundaries that remain

| Boundary | Required end-state behavior |
| --- | --- |
| Authority | A conference is advisory and cannot change project files, books, plans, approvals, checkpoints, or user-value decisions. |
| Isolation | The conference is a new Durable child, not a fork of the parent. It sees only captured conference material and its restricted tools. |
| Sources | Supplied context, selected files, and persona-specific book views are immutable, bounded, digested entry-time snapshots. They are consult-local records, not Case capsules. |
| Routing | The host, not a participant, selects the next eligible participant with an actually enforced finite enum grammar. The last speaker is excluded. |
| Provider context | Situation Prompt, stable tool contract, captured common sources, and append-only shared transcript remain the stable prefill. Routing swaps only the transient persona/selector tail. |
| Termination | Any participant may use `consult_return`. Limits, cancellation, invalid grammar support, malformed returns, and provider failure remain explicit incomplete/failure outcomes. |
| Scratch | V1 has only the auditable structured conference notebook. It has no arbitrary files, shell, executable scratch, or project promotion path. |
| Data loss | Migration never silently deletes legacy stories or cases, and archived bytes never enter a new conference request. |

## 3. Retirement boundary

The following are implementation inventory, not work to preserve.

| Retired surface | Current examples | Cutover result |
| --- | --- | --- |
| External consultation | `src/tools/consult.mjs` direct HTTP completion, `consultModel` settings, `thread` follow-ups | Replaced by the same-model conference under the single `consult` name. |
| Story persistence | `src/story.mjs`, storyteller shelf resolution, transcript-specific context/UI rendering | Migrated to static archive/shelf text, then removed from live runtime. |
| Evidence Case | `src/case.mjs`, `src/tools/case.mjs`, Case phase/task state, witness routing, `/case` UI | Retired as a complete vertical slice, not retained as a dormant tool. |
| Case policy and plumbing | Case limits/config, harness admission/receipt branches, Case-aware `return`, prompt wording, tests | Removed once migration confirms no live Case lifecycle remains. |
| Case roadmap | C1–C3 preservation, C4 scratch witness, E1 benchmark/escalation rule | Superseded. C1–C3 are historical implementation; C4 and E1 are intentionally dropped. |

The normal change/staging safety boundary remains unrelated retained infrastructure. It
must not be recast as consultation or legacy Case scratch.

## 4. Data and configuration migration contract

Migration exists to preserve user data while allowing the runtime to become smaller.
It is a one-shot cutover path, not a perpetual second product surface.

### 4.1 Inventory and gate

Before removing any live code, the cutover must inventory:

- `.brain/storyteller/` records and every shelf placement that depends on one;
- `.brain/cases/` records and their schema/version/terminal state; and
- active or resumable Case Durable children and task-state references.

A running, resumable, or otherwise nonterminal Case blocks the cutover. The user must
explicitly stop and archive it; migration must not orphan an isolated child, pretend it
finished, or silently discard its evidence.

### 4.2 Opaque legacy archive

For each successfully inventoried legacy record, migration must preserve the original
bytes and SHA-256 digest under a clearly labelled `.brain/legacy/` namespace and write
a static, human-readable export plus a compact manifest. The manifest records original
path/ID, schema/version where available, size, digest, export path, and migration time.

The archive is deliberately opaque to ordinary Cartographer operation:

- no new provider request reads it;
- no `consult`, tool, UI, or shelf resolver relies on a live Case/story parser;
- a later purge is explicit user action, never automatic cleanup; and
- a malformed legacy record stops its own migration and reports the path rather than
  being guessed at or deleted.

A legacy storyteller shelf placement becomes an ordinary immutable text snapshot during
migration. If its transcript cannot be parsed/rendered faithfully, the migration stops
before changing that placement. Old Durable transcript rows may remain historical data
in the session store, but no new lifecycle treats them as active Case or consultation
work.

### 4.3 Breaking inputs are explicit

Target `consult` accepts `question`, optional `context`, optional `files`, and required
`myPersona`. A legacy `thread` is a clear migration error, never a hidden external
fallback.

`consultModel`, `consultMaxTokens`, `consultTemperature`, `consultTimeoutSeconds`, and
`CARTO_CONSULT_MODEL` are removed. If they appear in a supported-upgrade configuration,
the migrator/config reader must name them and explain their removal rather than ignore
them or silently launch a second model.

## 5. Implementation slices after approval

No slice below is authorized by this document alone. The order prevents a temporary
product with two competing consultation systems.

### K1 — Consult-local record, entry capture, and isolated child

Create the `co<N>` conference record, immutable context/file/book snapshots, bounded
source manifest, empty-book representations, and independent same-model Durable child.
Use a small consult-local capture schema; do not import or generalize Case C1 objects.

**Acceptance:** mutations after entry cannot alter conference input; path/range escape
and uncaptured source access fail; the child cannot see the parent transcript or live
project/brain material; `myPersona` opens Cartographer and an empty book stays a valid
persona source.

### K2 — Persona turns, constrained selector, and preserved prefill

Add transient persona packets and the host-owned selector. The provider adapter must
enforce the exact eligible-ID grammar, not rely on a completion prefix or voluntary
tool call.

**Acceptance:** the prior speaker is excluded; selector output is exactly one valid ID;
unsupported grammar capability fails explicitly; outgoing persona instructions disappear
while spoken turns remain; participant → selector → participant requests retain the
same stable prefill and append-only shared transcript, swapping only the final tail.

### K3 — Return lifecycle and conference UI

Add restricted `consult_source` and `consult_return`, restart/cancellation/limit
recovery, final result projection to the caller, and an auditable conference view.

**Acceptance:** tool calls keep a participant active; a no-tool response triggers one
selector event; any participant can return; malformed return stays with its speaker;
limits never fabricate a synthesis; UI shows source/selector/turn provenance without
leaking private stream content into the parent chat.

### K4 — One cutover and deletion

Run the inventory/archive/shelf migration, block unsafe active Cases, reject legacy
configuration and call inputs clearly, then remove the obsolete verticals only after
K1–K3 pass their end-to-end acceptance suite.

**Deletion inventory:** external consult HTTP behavior and settings; `story` storage and
live story renderers; `case` creation/resume/phase/witness/synthesis paths; Case-specific
harness, return, state, terminal, screen, prompt, README, configuration, and tests.
Update public documentation atomically so it describes exactly one `consult` and no
`case` command.

**Acceptance:** a fresh install exposes one consultation contract and no Case tool;
there is no Mythos/external-model request path; migrated records retain verified
archive bytes/digests and readable shelf text without a live legacy parser; archived
data is absent from conference provider payloads; no Case child/task route remains
reachable; full tests and migration fixtures pass.

## 6. Explicit non-work

- No C4 executable/Case scratch runner.
- No E1 benchmark for choosing among products that will no longer coexist.
- No external-consult adapter, permanent story reader, or permanent Case reader.
- No generic snapshot or finite-choice framework before a second concrete surviving use
  demonstrates the need.
- No automatic legacy data purge.
- No claim that normal task staging or shell windows are conference scratch.
- No runtime implementation, deletion, or migration occurs until the user approves the
  implementation phase.

## Next action

Review this migration design against the conference proposal. Once approved, begin K1;
do not start deletion work early or preserve retired surfaces “just in case.”
