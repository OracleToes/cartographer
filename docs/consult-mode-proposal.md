# Proposal: same-model consultation conference

**Status:** delivered C1–C5 contract. `docs/plan.md` records the completed cutover, and the README describes the shipped behavior and migration boundary.
**Date:** 2026-11-16

> **Implementation note.** This document began as the design contract and remains the
> detailed rationale for the delivered conference. References to the retired external
> consult, storyteller transcripts, and Case product describe migration inputs only;
> C5 removed their live runtime surfaces.

## Decision summary

`consult` is a bounded, isolated **same-model consultation conference**, not a
one-shot request to a separately configured model and not a fixed sequence of analytical
lenses.

A call creates one independent Durable conference using the exact model of the
conversation that launched it. It starts with a caller-supplied temporary
`myPersona`, then lets a host-owned constrained selector choose which conference
participant speaks next. Participants are contextual personas, principally
personifications of Cartographer's durable books. They are stances with concerns and
vocabulary, not separate authorities, mutable book maintainers, votes, or independent
evidence.

Each participant may reason, speak, and call the deliberately restricted consultation
tools. A participant's turn ends when it emits an assistant response with no tool
calls. The host removes that persona's temporary request prompt, obtains one
**grammar-constrained enum choice** for the next eligible participant, and starts that
participant's turn. Any participant may end the conference only through a dedicated
`consult_return` call.

The first slice retains no arbitrary or executable scratch filesystem. Its private
working area is the durable conference transcript, participant-labelled turn records,
selector events, tool receipts, and immutable snapshots. It is private from the parent
prompt and has no project authority; it is not secret from audit/UI.

This is a consolidation, not an additional deliberation subsystem. It replaces both
the separate external-model consultation lane and the separate `case` product. The
conference takes only the small source-snapshot property it needs; it does not absorb
Case's capsule/artifact phases, blind-cross protocol, witness workflow, or scratch
ambition. The completed Case C1–C3 implementation is evidence about existing data and
migration work, not a reason to preserve that machinery. C4 and E1 are dropped rather
than carried forward as unfinished obligations.

## Retired predecessor (migration input only)

Before C5, `consult` used a separately configured external model and persisted
follow-up transcripts under `.brain/storyteller/`. The former `thread` field could
replay those transcripts through a different parent call. The former Case product had
its own records and lifecycle. Those formats are **not** conference records and are not
reinterpreted by the current runtime.

C5 inventories that material only to preserve it: exact bytes and digests live under
`.brain/legacy/raw/`, readable exports live under `.brain/legacy/exports/`, and old
storyteller shelf pointers become immutable text snapshots. No current source imports a
story or Case parser to read, continue, render, or send that material to a model.

## Current call contract

```js
consult({
  question: "Which migration boundary preserves compatibility?",
  context: "Constraints, observations, requested deliverable, and uncertainty.",
  files: [
    { path: "src/harness.mjs", range: "360-640" },
    { path: "src/tools/consult.mjs" }
  ],
  myPersona: "I am Cartographer for this conference: I know the project goal, care about ..."
})
```

| Field | Contract |
| --- | --- |
| `question` | Required bounded question and desired deliverable. It is a conference objective, not project-change authority. |
| `context` | Optional supplied text. The exact bytes sent are captured as an immutable, digested source. |
| `files` | Optional bounded project-relative paths or catalog file references, with optional line ranges. They are captured before the conference starts. |
| `myPersona` | Required bounded, consult-local identity for the opening Cartographer participant. It describes the caller's project-local perspective and concerns for this conference only; it grants no authority and is not retained as a parent-session prompt. |

There is no live `thread` follow-up interface. The schema recognizes a supplied legacy
field only to refuse it directly with a C5 migration error; it never reads or resumes a
transcript. A conference has one explicit lifecycle and one return boundary. A later
question starts a fresh conference with selected prior material rather than reviving a
half-finished role conversation.

The call can originate in the main conversation or ordinary focus and returns only to
that caller. A conference participant cannot invoke `consult`, so conferences never
nest. There is no Case phase, witness, or other retired-product caller.

## Conference model

### Participants and book personas

The conference roster is a fixed, versioned registry. Its initial core is:

| Participant ID | Role | Private consult-local source |
| --- | --- | --- |
| `cartographer` | The caller-defined project-local Cartographer perspective. It opens the conference using `myPersona` and thereafter is an ordinary selectable participant. | `myPersona`; no privileged live parent context. |
| `atlas` | Maps topology, relationships, boundaries, missing orientation, and what is not yet mapped. It does not improve or edit the atlas. | Immutable snapshot of the atlas book. |
| `ledger` | Examines claims, hypotheses, evidence, questions, assumptions, and what would change a conclusion. It does not edit the ledger. | Immutable snapshot of the ledger book. |
| `plan` | Examines scope, sequencing, dependencies, closure conditions, and tradeoffs. It does not authorize or edit a plan. | Immutable snapshot of the plan book. |
| `assessment` | Frames project-level understanding, gaps, and contradictions against the durable assessment. It does not rewrite it. | Immutable snapshot of the assessment book. |
| `context` | Notices what has been retained, omitted, or needs clarification at the durable-context boundary. It does not collapse, fold, or edit context. | Immutable snapshot of the relevant context/book view. |

The registry may later gain personas, but a new persona is a versioned policy change,
not a prompt string silently invented during a conference.

A persona exists even when its book is empty or missing. The empty snapshot is still a
canonical, digested source saying that no current entries were available; the persona's
role prompt still tells it what that absence means and what concerns it should bring.
It must not become silent merely because the associated book has no content.

Each persona receives only:

1. the shared Situation Prompt and conference history;
2. the caller-supplied question/context and attached file snapshots;
3. its own role prompt; and
4. its own corresponding **entry-time book snapshot**.

It does not receive live book contents, another persona's private book snapshot, the
parent's ambient state block, shell windows, or arbitrary `.brain` material. A book
snapshot is evidence for a persona's perspective, not its identity and not proof that
its contents are correct.

`cartographer` is not chair, owner, or final speaker. After its opening turn it is an
ordinary eligible participant, just as Atlas, Ledger, Plan, Assessment, and Context
are.

### Prompt and request order

The effective request for a participant is conceptually ordered as:

```text
Situation Prompt
→ restricted consultation tool schema
→ immutable conference question, supplied context, file-source manifest, and shared transcript
→ active participant's role prompt and its own book snapshot
```

The Situation Prompt establishes the conference's purpose, safety boundary, speaker
protocol, source-citation rules, and return semantics. Tool declarations are provider
metadata on APIs that represent them outside messages, but their authority is part of
the same stable conference contract.

The active persona is **request-local**, not an accumulating system message. Its
instruction is injected at the tail of that participant's provider request and omitted
from the next request. Its *spoken contribution* remains as a labelled, model-visible
durable conference entry—for example, `Atlas: ...`—with matching host metadata. This
distinction is required: appending a persona system message to the transcript would
leave old personas active during later speakers' turns.

A selector result is likewise appended as a small model-visible conference event, such
as `Selector chose: atlas`, while its structured record remains host-owned. The
selector is therefore auditable and intelligible to the next speaker without itself
becoming a persona or contributing prose analysis.

The stable Situation Prompt and common conference history remain at the front of the
provider context. A speaker swap changes only a small suffix, preserving prefix-cache
value rather than reloading the whole conference for each persona.

### Prefill invariant

Keeping the common prefix warm is a correctness and performance requirement, not a
hopeful optimization. Define `P(H)` as the provider prefill for append-only shared
conference history `H`:

```text
P(H) = Situation Prompt + stable tool contract + entry packet/source manifests + H
```

An ordinary handoff must use the same live conference and progress only as follows,
where `C` is the completed participant contribution and `S` is the recorded selector
choice:

```text
active participant:      P(H)       + active-persona tail
neutral selector:        P(H + C)   + constrained-selector tail
selected participant:    P(H + C+S) + selected-persona tail
```

Thus the stable Situation Prompt, tool contract, captured common sources, and every
already-recorded shared entry keep their byte-for-byte content and order at the front
of each later request. The only replacement is the final transient tail: remove the
outgoing persona packet, add the selector packet, then replace that selector packet
with the selected persona packet. `C` and `S` are append-only conference entries, not
new request heads.

Persona removal or selection must never empty, reset, fork, compact, replace the
Durable head, or rebuild the shared conference as a new prompt. A selector runs against
the same active provider context, emits one ID, and leaves that common prefill intact.
A full reread/reconstruction is an invariant failure, not normal routing.

The implementation must capture request plans/payloads in tests across
participant → selector → participant handoffs and assert the stable-prefix identity,
append-only shared history, tail-only replacement, one continuing Durable head, and
absence of reset/compaction. UI/provider accounting should make a broken
prefix-cache invariant visible rather than quietly treating a full reread as normal.

### Turn and handoff protocol

1. At entry, the host activates `cartographer` with the caller's `myPersona` and
   starts its turn.
2. An active participant may emit text, call one or more permitted tools, or both in
   one assistant response. Tool results return to that same active participant; it
   continues its turn and can reason or speak again.
3. A response with **no tool calls** is that participant's completed spoken turn. The
   host records it with the participant ID, then removes the active persona prompt.
4. The host runs the neutral selector over the shared conference state and records a
   `select_persona` event.
5. The selected participant gets its own temporary role/book packet and takes the
   next turn.
6. The only normal successful end is a valid `consult_return` from any active
   participant. The host commits the result before terminating the conference.

An assistant response that calls `consult_return` is a tool-calling response, but a
successful return terminates the entire conference rather than continuing that
participant. A malformed return is a tool error; the same participant remains active
and can correct it.

Hard turn/time/output/provider/storage/cancellation exits remain explicit
`interrupted`, `failed`, or `cancelled` records. They never fabricate a synthesis.

## Neutral selector and constrained decisions

### Selector contract

The selector is not a participant and does not speak prose into the conference. It is
a host-owned small inference request made after a completed participant turn. It sees:

- the Situation Prompt and shared conference transcript;
- a compact, host-built decision tail naming the current roster and their role
  criteria;
- the just-completed speaker; and
- the eligible candidate set.

It sees **no active persona prompt** and has no consultation tools. The conference
transcript is the decision state; the selector does not need a clean/reset context. It
does need a clean decision surface at the tail: no persona instruction, no ambient
main-session state, and no unconstrained prose task.

For a roster such as `cartographer`, `atlas`, `ledger`, `plan`, `assessment`, and
`context`, the host builds a grammar from the eligible IDs:

```text
root ::= "cartographer" | "atlas" | "ledger" | "plan" | "assessment" | "context"
```

The selector's completion is constrained by that grammar, uses a very small output
budget and low/zero temperature, and returns **only one member ID**. It is not a
voluntary participant tool call. The host validates the result, appends a durable
selection event, and activates the corresponding persona.

The candidate set is `roster − previousSpeaker`: the same participant cannot be
selected twice in succession. That rule does not cut off a participant while it has
made tool calls; tool calls keep it within its current turn before the selector runs.
If no eligible member exists, the conference is explicitly blocked rather than silently
violating the no-consecutive-speaker rule.

The selector reports no pretend numeric confidence. In v1, “confident” means a bounded
choice from the actual context, enforced grammar, host validation, deterministic
eligibility, and explicit failure handling—not a Jev-calibrated probability.

### Implementation precondition

A bare completion prefix such as `The next member to speak is:` is insufficient: an
ordinary unconstrained model can emit prose, an alias, or an invalid name. The
conference selector requires a provider adapter that actually enforces a finite-choice
grammar. The implementation must probe and test that capability against the configured
server.

If a server cannot enforce the grammar, it must not silently downgrade to an
unconstrained persona-routing answer. A separately approved fallback could use a strict
enum response schema or forced typed call, but that is not this v1 contract.

### General decision direction

The selector demonstrates a small host-owned finite-choice pattern:

```text
bounded state + explicit finite candidates + enforced enum grammar → one validated ID
```

It is a pattern, not a new project-wide decision framework. Keep it consult-local until
a second concrete routing need justifies extracting a shared helper. Any later use must
supply its own state packet, candidate registry, grammar support, failure policy, and
tests.

This style is appropriate for model-mediated semantic/routing choices, such as which
conference perspective should speak next. It never replaces deterministic or authority
decisions: approval, schema validation, path confinement, resource limits, permission
checks, checkpoint validation, and sandbox policy remain host-enforced rules, never
model choices. “Use constrained decisions where applicable” is not permission to turn
security or correctness invariants into inference.

## Same model and isolated Durable architecture

### Model capture

At conference creation, read the launching conversation's resolved model through
`api.agent(context).model` and store its `{ provider, modelId }` in the conference
record. Both participant turns and selector decisions use that captured model through
the normal provider path.

The captured model comes from the launching agent rather than from `config.model` as a
second lookup, and there is no `config.consultModel` setting:

- it honors a model selected by `/model`;
- it honors a focused caller that retained a different agent model;
- later model changes do not rewrite an active conference; and
- it removed the automatic external-model switch.

Retired `consultModel`, token, temperature, and timeout settings have no role in
conference mode. Their presence is a direct migration error rather than a silently
ignored value or an external-consult compatibility adapter.

### Independent conversation, not a fork

The conference is a new independent Durable conversation. It must not use
`forkConversation()`: a fork inherits the parent transcript and violates the intended
isolation.

The existing Durable primitives support the design:

- `api.agent(context)` resolves the calling agent/model;
- a tool commit can create a child with `tx.createConversation({ ownership })`, then
  `configure(tx, child.id, conferenceAgentProfile)` and append a seed entry in the
  same commit;
- the profile can select extensions, enabled tools, model tools, instructions, and
  turn limits; and
- `api.conversation(childId, context)`, `submit({ type: "continue" })`, and `wait()`
  can drive the child while the outer tool remains pending.

The outer tool persists its conference ID and child ID idempotently before waiting,
using its durable memo/details path. The child is owned by the outer tool task, so
cancellation follows the caller. Restart recovery locates the existing record and
child rather than creating another conference.

### Request-local persona plumbing

The consultation extension needs a request-planning hook and a durable conference
state record. The hook builds one provider payload from the same shared child
transcript, then conditionally appends one of two tail packets:

- an active participant packet: role prompt plus that participant's frozen book
  snapshot; or
- a selector packet: eligible IDs and the constrained-selection instruction, with
  no participant prompt.

The selector request is host-owned and writes a `select_persona` event, not an
assistant sentence attributed to a persona. The participant's actual assistant answer
is preserved in the Durable transcript with participant metadata so the UI and audit
log can label it accurately.

This is preferable to repeatedly configuring persistent `instructions` or appending
system messages: both would retain the old persona in later context. It also preserves
the stable head needed for provider prefix caching.

## Restricted tool surface

The conference profile exposes only:

| Tool | Authority |
| --- | --- |
| `consult_source` | Lists, reads, or searches immutable caller-attached file/context snapshots only. It never resolves a live project path. |
| `consult_return` | Any active participant may call it to validate and persist the final structured synthesis, then terminate the conference. |

There is no ordinary `read`, `search`, `list`, `book`, `shelf`, `write`, `edit`, `rm`,
`shell`, `task`, `chat`, `ask`, `wake`, `sleep`, ordinary focus `return`, or nested
`consult`. There is no direct network tool. Persona/book prompts never grant an ability
to update their real counterparts.

A dedicated conference extension selects exactly these tools through both the enabled
`tools` and model-visible `modelTools` lists, and defends that list in its own tool
hook. It does not select the ordinary `cartographer` extension and merely ask the
model to behave: that would retain the main prompt and broader authority.

## Immutable supplied and book snapshots

### Entry capture

Before starting the conference, the host captures:

1. `context` as source `c0`, preserving the exact bytes sent and clipping fact;
2. each requested file/range after normal project-confinement, symlink, count, line,
   and byte checks; and
3. a canonical snapshot for every book persona's mapped book, including canonical
   empty snapshots when a book has no material.

Each snapshot receives an ID, kind, source label, range/version metadata where
relevant, size, and SHA-256 digest. The host stores private immutable copies under the
conference record. A later project or brain change does not alter what a participant
or selector sees in that conference.

This is a compact conference-owned capture contract, not adoption of Case C1's
capsule, ledger, receipt, artifact, or phase schema. Existing C1 records inform the
retirement migration only. Do not extract a generic snapshot framework until another
surviving product need demonstrates one.

`consult_source` can reread/search caller-attached file snapshots. It cannot broaden a
range, access a sibling path, read a live book, or observe new project bytes. A persona
gets its corresponding book snapshot by request construction, not by a broad book-read
tool.

### Record shape

Use a separate versioned record namespace, for example:

```text
.brain/consults/<consultation-id>.json
.brain/consults/<consultation-id>/sources/<source-id>
```

Records use new `co<N>` IDs, never legacy `st<N>` IDs, and retain at least:

- schema version, conference ID, caller/call identity, captured model, and child
  Durable conversation ID;
- question, `myPersona` digest/metadata, supplied context/files, and all snapshot
  digests/clipping/refusal facts;
- roster version and participant-to-book mapping;
- participant-labelled turns, tool receipts, selector events, eligibility facts, and
  termination/budget facts;
- final `consult_return` object and artifact digest when present; and
- interruption/cancellation/failure facts when no final return exists.

The child Durable transcript in `.brain/session.sqlite` remains the full conversational
provenance. The JSON record is the durable index, state machine, snapshot manifest, and
human-facing audit artifact. The parent receives only the final rendered synthesis and
`co<N>` metadata, not the entire private conference stream.

## Return, scratch, UI, and retention

### Dedicated return

`consult_return` is separate from the existing task `return`. It carries a structured
answer such as:

```js
{
  outcome: "answered" | "unresolved" | "needs_input" | "blocked",
  synthesis: "...",
  recommendation: "...",       // optional when unresolved
  evidence: [{ source: "s1", claim: "..." }],
  assumptions: ["..."],
  uncertainties: ["..."],
  alternatives: [{ option: "...", tradeoff: "..." }],
  next_checks: ["..."],
  blocking_question: "..."      // required for needs_input
}
```

Any active participant can make this call. The host adds provenance—speaker ID,
participant/book snapshot IDs, ordered selector history, timestamps, and final digest.
A citation means a snapshot was consulted, not that a claim is proven. The parent still
verifies claims against current sources/tests and keeps user-value decisions with the
user.

### Scratch-space decision

| Level | Capability | Decision |
| --- | --- | --- |
| 1 — structured conference notebook | Participant-labelled transcript, selector events, tool receipts, return artifact, and immutable source/book snapshots. No arbitrary path or command. | **Included in v1.** |
| 2 — text-only private files | Explicit bounded `consult_scratch` read/write/list over a non-executable per-conference store with retention, manifest, and digest rules. | **Deferred.** Requires a separate privacy/retention/UI decision. |
| 3 — executable scratch | Disposable execution surface with private root, read-only source projection, resource limits, receipts, cleanup, and no automatic project application. | **Not in conference v1.** Requires separately proven confinement. |

Level 1 is working memory, not a side channel. The parent does not receive it
implicitly, but the user can inspect it deliberately in the conference audit view. It
cannot mutate project files, shared books, or the durable main brain.

Level 2 must not reuse the project, `.brain`, a generic temporary directory, or
persistent shell windows. Any later Level 3 proposal must independently establish a
fresh private root outside project/brain, a fixed read-only projection with `.git` and
`.brain` absent, disposable home/cache/tmp, network disabled by default, enforced
resource limits, retained receipts/digests, cleanup evidence, and no automatic project
promotion. Normal sandbox arguments and session windows are not consultation scratch.

### UI

The Work view renders conference audits on demand from their `co<N>` records. It has no
live storyteller or Case renderer; historical consultation rows are labelled as static
archive notices. Conference rows show:

- `co<N>`, captured model, lifecycle state, elapsed/budget facts, and grammar-adapter
  availability;
- current speaker, completed turns, selector history, and no-consecutive-speaker
  enforcement;
- roster and each participant's role/book snapshot status, including an explicit
  empty-book state;
- supplied-file and book-source manifests with digests, ranges, clipping, and citations;
- tool receipts, final return, or explicit incomplete reason; and
- the scratch declaration: structured conference notebook only; no filesystem or
  command scratch.

While a conference runs, the Work view reads the durable record named in the outer
call's details. It can show speaker/selector progress without streaming every private
assistant thought into the parent chat. Expanding the row is an explicit audit action.

Snapshots and artifacts are retained with the consultation record under the brain's
lifecycle, subject to policy caps. A future purge/export policy must leave visible
provenance (for example, “sources purged”) rather than a dangling apparently
reproducible result.

## C5 delivered cutover

C5 completed the replacement rather than leaving a compatibility layer. There is no
`consult_external`, external-model fallback, story lifecycle, separate `case` tool, or
Case runtime.

1. **Inventory and strict blocker.** The migrator inventories legacy storyteller
   bytes, shelf placements that resolve through them, Case records, and retired Case
   task metadata. Any active, resumable, unreadable, or malformed Case blocks startup.
   The user must use the pre-C5 release to explicitly stop unfinished work; no flag or
   automatic conversion can orphan it.
2. **Static archive.** Terminal records are copied byte-for-byte into
   `.brain/legacy/raw/`, SHA-256 digests are recorded in the manifest, and readable
   static exports are written to `.brain/legacy/exports/`. A missing export can be
   regenerated from the raw bytes without a former-product parser.
3. **Inert shelf/context conversion.** A legacy storyteller placement becomes an
   ordinary immutable snapshot with archive metadata. If pointers or retired Case task
   metadata require a context rewrite, the exact pre-rewrite context bytes are also
   archived and exported before the live context changes.
4. **Explicit broken inputs.** `consult` takes `question`, optional `context`, optional
   `files`, and required `myPersona`; a supplied `thread` is refused. Retired
   `consultModel`, token, temperature, timeout, and environment settings are rejected
   as removed configuration rather than ignored or reused.
5. **Deletion.** External HTTP consultation behavior, story persistence/rendering, Case
   creation/resume/phase/witness behavior, Case-specific harness and return branches,
   policy/config limits, prompt/UI commands, and their old tests were removed. Archive
   existence does not retain a live adapter or reader.

## Delivered acceptance evidence

- `co<N>` records capture caller/file/book snapshots with digests; tests prove later
  file/book mutation cannot change the entry packet.
- An independent Durable child uses the launching conversation's captured model,
  request-local personas, and only `consult_source`/`consult_return` authority.
- The provider adapter probes a required finite grammar choice; selector records are
  durable, exclude the prior speaker, retain a common append-only prefix, and fail
  explicitly when the capability is unavailable.
- Participant return, malformed return, recovery, cancellation, limits, and bounded
  request-plan audit retention are tested without fabricating a result.
- Cutover tests prove fresh requests expose only conference consultation, archived
  bytes/digests/export recovery stay readable, legacy shelf text is inert, and no
  archived material or second configured model enters a conference request.

## Non-goals

The conference is not a panel of independent agents, a vote, a source of corroboration,
a project worker, a user-facing persona, a replacement for authority checks, or a route
around approval and change policy. It does not preserve Case's blind-evidence,
artifact/witness, or scratch subsystem under new names. Book personas do not update
their books. A grammar-constrained selector is not a Jev-calibrated decision model and
must not be described as one. The proposal does not claim sandbox or persistent terminal
execution as scratch.
