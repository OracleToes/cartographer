# Proposal: same-model consultation conference

**Status:** delivered C1–C5 contract plus native-GBNF control-plane cutover. [The Phase 2 UI delivery plan](./ui-redesign-phase-2-architecture-plan.md) records the active delivery sequence, and the README describes the shipped behavior and migration boundary.
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
`myPersona`, then lets a host-owned constrained selector make a finite
**continue-or-report** decision. Participants are contextual personas, principally
personifications of Cartographer's durable books. They are stances with concerns and
vocabulary, not separate authorities, mutable book maintainers, votes, or independent
evidence.

Each participant may reason, speak, and call the deliberately restricted consultation
tools. A participant's turn ends when it emits an assistant response with no tool
calls. The host removes that persona's temporary request prompt and obtains one
**grammar-constrained finite choice**. Before an actual exchange has occurred, the
choice can only continue with an eligible participant. Once the host has recorded the
minimum debate—two completed contributions from two distinct participants—and
Cartographer is eligible, the choice may instead authorize Cartographer to write the
final advisory. Deliberating participants cannot end the conference; only that
host-authorized Cartographer report can call `consult_return`.

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

`cartographer` is not chair, owner, or project authority. During debate, after its
opening turn, it is an ordinary eligible participant just as Atlas, Ledger, Plan,
Assessment, and Context are. It becomes the final speaker only after the separate host
native decision authorizes `report:cartographer`; that authorization grants no authority
beyond writing the structured advisory.

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
the same stable conference contract: a debate request declares only `consult_source`;
a host-authorized Cartographer report declares `consult_source` and `consult_return`.

The active persona is **request-local**, not an accumulating system message. Its
instruction is injected at the tail of that participant's provider request and omitted
from the next request. Its *spoken contribution* remains as a labelled, model-visible
durable conference entry—for example, `Atlas: ...`—with matching host metadata. This
distinction is required: appending a persona system message to the transcript would
leave old personas active during later speakers' turns.

After a raw selector result is validated, the host appends one labelled model-visible
conference event—for example, `Native GBNF selected atlas to continue the bounded
debate` or `Native GBNF authorized Cartographer to write the final advisory report`—
before the selected participant's tail. The raw selector request itself is not a Durable
conversation entry. The recorded host event makes the decision auditable and
intelligible to the next speaker without turning the selector into a persona or allowing
it to contribute prose analysis.

The stable Situation Prompt and common conference history remain at the front of each
**participant** provider request. A speaker swap changes only a small suffix, preserving
prefix-cache value rather than reloading the whole conference for each persona.

### Prefill invariant

Keeping the common prefix warm is a correctness and performance requirement, not a
hopeful optimization. Define `P(H)` as the provider prefill for append-only shared
conference history `H`:

```text
P(H) = Situation Prompt + stable tool contract + entry packet/source manifests + H
```

An ordinary handoff preserves the child only for participant work. Let `C` be a
completed participant contribution and `S` the labelled host continuation recording a
validated selection:

```text
active participant:      P(H)       + active-persona tail
raw native selector:     bounded question + labelled C + eligible roster + continue/report GBNF grammar
selected participant:    P(H + C + S) + selected-persona tail
```

The raw selector is deliberately outside `P(H)`: it has no Durable conversation,
tools, active persona packet, or prefix-cache obligation.

Participant turns keep the stable Situation Prompt, restricted tool contract, captured
common sources, and append-only shared conference history at the front of later
participant requests. Their final transient tail is the active participant packet.

The selector deliberately does **not** reuse that provider request. It is a small raw
llama.cpp request with its own compact host-built state packet: the bounded question,
completed labelled contributions, current roster criteria, and eligible IDs. It omits
all tools, active/private persona packets, captured raw source text, and parent-session
history. This keeps the decision surface small and makes native GBNF the only output
boundary; it is not a prompt cache optimization.

Tests capture participant request plans and native-selector request plans separately.
They assert one continuing Durable child for participants, append-only shared history,
private persona removal, no tool surface on selection, finite output validation, exactly
one labelled handoff, and explicit failure rather than an unconstrained route.

### Turn and handoff protocol

1. At entry, the host activates `cartographer` with the caller's `myPersona` and
   starts its opening debate turn.
2. An active debate participant may emit text, call `consult_source`, or both in one
   assistant response. Tool results return to that same participant; it continues its
   turn and can reason or speak again. `consult_return` is neither declared nor
   accepted during debate.
3. A response with **no tool calls** is that participant's completed spoken turn. The
   host records it with the participant ID, then removes the active persona prompt. If
   that turn reaches the conference limit, the host records an interruption without
   making an unused decision.
4. Otherwise, the host makes one separate no-tools native-GBNF selector request over
   its compact decision packet. The host-enforced gate requires two completed turns
   from two distinct participants before `report:cartographer` exists in the grammar.
   The selector validates one exact `continue:<eligible-id>` or, when eligible,
   `report:cartographer` value and records the native decision event.
5. A continuation gives the chosen participant its own temporary role/book packet and
   starts the next debate turn. A report decision gives Cartographer its temporary
   packet plus the terminal tool, and explicitly tells it to write the final advisory.
6. The only normal successful end is a valid `consult_return` from that
   host-authorized Cartographer report. The host commits the result before terminating
   the conference.

An assistant response that calls `consult_return` is a tool-calling response, but a
successful return terminates the entire conference rather than continuing Cartographer.
A malformed return is a tool error; Cartographer remains in its authorized report state
and can correct it. If that report instead ends without the tool call, the host records
a failure rather than selecting another participant or fabricating a synthesis.

If a process stops after recording a completed participant turn but before routing,
the durable `selector` state is recovered by rerunning the same raw native choice.
If it stops after selection but before the child receives the labelled continuation,
the pending marker recreates that continuation exactly once before the selected
participant's request. A failed selector ends the record; it never substitutes prose.

Hard turn/time/output/provider/storage/cancellation exits remain explicit
`interrupted`, `failed`, or `cancelled` records. They never fabricate a synthesis.

## Neutral selector and constrained decisions

### Selector contract

The selector is not a participant and does not speak prose into the conference. It is
a host-owned raw llama.cpp request made after a completed participant turn. It sees:

- the bounded consultation question;
- completed **labelled participant contributions**, clipped by a host cap;
- a compact host-built roster/criterion packet, the just-completed speaker, and the
  eligible candidate set.

It sees **no active or private persona prompt**, no captured raw project/source text,
no parent-session state, and no consultation tools. The raw request is intentionally a
clean decision surface rather than a replay of the Durable transcript.

For a roster such as `cartographer`, `atlas`, `ledger`, `plan`, `assessment`, and
`context`, the host builds a grammar from finite host-owned decision values. After the
opening contribution, for example:

```text
root ::= "continue:atlas" | "continue:ledger" | "continue:plan" | "continue:assessment" | "continue:context"
```

After at least two completed turns by at least two distinct participants, if the prior
speaker is not Cartographer, the host may add the sole terminal value:

```text
root ::= "continue:cartographer" | "continue:ledger" | … | "report:cartographer"
```

The selector's raw completion carries llama.cpp's native `grammar` field, uses a very
small output budget and zero temperature, and returns **only one host-generated
continue-or-report value**. It has no tool or `tool_choice` field. The host validates
the exact result, appends a durable decision event with method/HTTP/finish/timing and
debate-gate facts, then activates the corresponding debate participant or authorized
Cartographer report state.

Continuation candidates are `roster − previousSpeaker`: the same participant cannot
be selected twice in succession. That rule does not cut off a participant while it has
made tool calls; tool calls keep it within its current turn before the selector runs.
The host adds `report:cartographer` only when its minimum debate gate is met and
Cartographer is in that eligible continuation set. If no eligible member exists, the
conference is explicitly blocked rather than silently violating the no-consecutive-
speaker rule.

The selector reports no pretend numeric confidence. In v1, “confident” means a bounded
choice from the actual context, enforced grammar, host validation, deterministic
eligibility, and explicit failure handling—not a Jev-calibrated probability.

### Implementation precondition

A bare completion prefix such as `The next member to speak is:` is insufficient: an
ordinary unconstrained model can emit prose, an alias, or an invalid name. Native
llama.cpp GBNF enforcement is therefore a **Cartographer platform requirement**, not
an optional consultation adapter. Cartographer proves a deliberately adversarial
forced-literal grammar when it opens a session and before it adopts another model.

If a server/model route cannot enforce the grammar, Cartographer refuses the session or
model switch. It does not downgrade to an unconstrained answer, a strict JSON schema,
an OpenAI custom tool, ordinary function calling, or a second provider.

`/consult probe [PATH]` retains inspectable evidence: it makes two synthetic no-tool
calls through native `grammar`, a forced literal and a finite roster, and writes raw
request/response material without project or conference data. It is an audit tool for
the same required runtime boundary, not a toggle or a fallback claim.

### General decision direction

The selector demonstrates a small host-owned finite-choice pattern:

```text
bounded state + explicit finite continue/report values + enforced enum grammar → one validated host decision
```

This is a Cartographer-wide control-plane pattern, implemented in the shared
`native-grammar` boundary. It serves every host-owned model decision with a finite or
fixed answer shape: the mandatory capability proof, conference routing, and the
optional pre-collapse `{"handoff":true|false}` decision. Each caller supplies its own
bounded state packet, candidate set/grammar, validation, failure policy, and tests.

This style is appropriate for model-mediated semantic/routing choices. It never
replaces deterministic or authority decisions: approval, schema validation, path
confinement, resource limits, permission checks, checkpoint validation, and sandbox
policy remain host-enforced rules, never model choices. “Use constrained decisions
where applicable” is not permission to turn security or correctness invariants into
inference.

## Same model and isolated Durable architecture

### Model capture

At conference creation, read the launching conversation's resolved model through
`api.agent(context).model` and store its `{ provider, modelId }` in the conference
record. Participant turns use that captured model through the normal provider path;
raw native selector requests use the same captured model ID against Cartographer's
configured llama.cpp endpoint.

The captured model comes from the launching agent rather than from `config.model` as a
second lookup, and there is no `config.consultModel` setting:

- it honors a model selected by `/model`;
- it honors a focused caller that retained a different agent model;
- later model changes do not rewrite an active conference; and
- it removed the automatic external-model switch.

Retired `consultModel`, token, temperature, timeout, and `consultGrammar` settings
have no role in conference mode. Their presence is a direct migration error rather than
a silently ignored value or an external-consult/native-grammar compatibility adapter.

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
state record. Participant provider requests append one active participant packet: role
prompt plus that participant's frozen book snapshot.

After a no-tool participant response, the host separately builds the raw native
continue-or-report selector packet and posts it directly to the configured llama.cpp
endpoint. The decision event is host-owned—not an assistant sentence or model tool
call—and records the validated continuation or Cartographer-report authorization plus
native response and debate-gate facts. The participant's actual assistant answer remains
in the Durable transcript with participant metadata so the UI and audit log can label it
accurately.

This is preferable to repeatedly configuring persistent `instructions` or appending
system messages: both would retain the old persona in later context. Participant
requests retain their ordinary stable prefix; the selector intentionally uses its own
compact no-tools decision payload.

## Restricted tool surface

The conference profile exposes only:

| Tool | Authority |
| --- | --- |
| `consult_source` | Lists, reads, or searches immutable caller-attached file/context snapshots only. It never resolves a live project path. |
| `consult_return` | Declared and accepted only for Cartographer after the host's native `report:cartographer` decision. It validates and persists the final structured synthesis, then terminates the conference. |

There is no ordinary `read`, `search`, `list`, `book`, `shelf`, `write`, `edit`, `rm`,
`shell`, `task`, `chat`, `ask`, `wake`, `sleep`, ordinary focus `return`, or nested
`consult`. There is no direct network tool. Persona/book prompts never grant an ability
to update their real counterparts.

A dedicated conference extension owns exactly these tool implementations and defends
the active surface in its provider hook: debate payloads expose only
`consult_source`, while only the host-authorized Cartographer report exposes both
listed tools. It does not select the ordinary `cartographer` extension and merely ask
the model to behave: that would retain the main prompt and broader authority.

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
sees in that conference; the native selector sees only completed labelled contributions,
not the raw snapshot bodies.

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
- participant-labelled activity (reasoning, chat/prose, and local tool calls), completed
  turns, bounded tool receipts, selector events, eligibility facts, and termination/budget
  facts;
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

The call is available only after the host-native `report:cartographer` decision puts
Cartographer in its authorized report state. Debate participants cannot invoke it: it
is omitted from their provider payload and a direct tool invocation is refused. The
host adds provenance—Cartographer's opening-persona packet ID, ordered native decision
history, debate-gate facts, timestamps, and final digest. A citation means a snapshot
was consulted, not that a claim is proven. The parent still verifies claims against
current sources/tests and keeps user-value decisions with the user.

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

Chat has a dedicated **Consult** subview. It is the only screen projection allowed to
read or render a `co<N>` notebook: Conversation and Work retain no conference row,
private receipt, child reasoning, or audit expansion. A parent `consult` call is only a
correlation pointer, never a path by which private material reaches parent history or
project authority. Historical pre-cutover rows remain compact isolated notices rather
than a revived storyteller/Case renderer.

A conference timeline shows:

- `co<N>`, captured model, lifecycle state, elapsed/budget facts, and native-grammar
  selection evidence;
- the full fixed roster—Cartographer, Atlas, Ledger, Plan, Assessment, and Context—with
  active/ready/final status;
- persona-attributed, independently foldable blocks for reasoning, chat/prose, local
  tool calls, local tool results, host-native debate-routing and final-report decisions,
  and the final advisory;
- local durable activity plus the current child stream/tool output while a conference is
  running, without adding either to parent Work or context;
- supplied-file and book-source manifests with digests, ranges, clipping, and citations;
  and
- the scratch declaration: structured conference notebook only; no filesystem or
  command scratch.

Copying a conference or one of its blocks exports only that Consult projection. Durable
participant activities and tool receipts use stable event/call identities for restart
idempotence, while bounded retention keeps an unbounded tool loop from making the
conference record grow indefinitely. A future purge/export policy must leave visible
provenance (for example, “sources purged”) rather than a dangling apparently reproducible
result.

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
- An independent Durable child uses the launching conversation's captured model and
  request-local personas. Debate payloads expose only `consult_source`; only the
  host-authorized Cartographer report exposes `consult_return`.
- A shared native-GBNF boundary proves the selected endpoint/model at session open and
  model switch. Selector records are durable, exclude the prior speaker, retain native
  HTTP/timing and debate-gate facts, choose continue-or-report values, and fail
  explicitly rather than using an unconstrained fallback.
- Premature return refusal, host-authorized Cartographer return, malformed return,
  recovery, cancellation, limits, and bounded request-plan audit retention are tested
  without fabricating a result.
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
