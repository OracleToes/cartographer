# Bounded deliberation cases

**Status:** proposal, not implemented. 2026-11-16.

`docs/design.md` remains the source of intent. This document describes a possible second generation of the existing evidence-case facility; it makes no claim that the proposed procedure, scratch runner, or benchmark has been implemented or measured.

## Decision in one sentence

Make a case a **bounded deliberation procedure by one agent through isolated operational lenses**: freeze a small evidence capsule, construct a falsifiable account, perform a blind counterexample hunt, permit a bounded cross-examination only after that blind pass is recorded, obtain one real witness or name its exact closure gap, and let the main context make the only conclusion.

This is not a committee. Separate contexts create context distance, anti-anchoring, and reproducible obligations. They do not create independent model judgment, votes, or corroboration.

---

## 1. Why this is a v2 proposal rather than a prompt rewrite

The current evidence-case implementation already establishes a valuable baseline:

- `src/case.mjs` stores a frozen capsule, phase state, participant routes, clipped artifacts, and main-context synthesis in `.brain/cases/c<N>.json`.
- `src/tools/case.mjs` runs three isolated same-model contexts: construction, blind falsification, and a source-only witness phase.
- construction prose is deliberately absent from the blind falsifier's initial context;
- phase contexts cannot write the project, use shell windows, edit the shared brain or shelf, start nested work, call `consult`, or turn agreement into a vote;
- the main context alone records `supported`, `refuted`, or `unresolved`.

That is a real implementation of controlled visibility. It is not yet the full procedure described here.

| Existing v1 behaviour | Missing for the intended procedure |
| --- | --- |
| The capsule freezes supplied text and selected shelf snapshots with digests. | Resolution criteria, non-goals, source roles, freshness at capture, a case evidence ledger, and a phase budget contract are not first-class rendered data. |
| Construction and falsification write clipped free-form reports. | Their artifacts have no enforced candidate / observation / assumption / citation / falsifier structure. |
| Falsification is blind to construction. | It never receives the constructor's cited claim after its blind pass, so there is no direct cross-examination. |
| Witness can inspect sources with `read`, `search`, and `list`. | It cannot run a test, trace, proof check, minimal reproduction, or isolated experiment. |
| Every case is source-only and read-only. | There is no case-scoped disposable scratch environment, artifact provenance, cleanup, or promotion contract. |
| The main context synthesizes a durable outcome. | It does not yet receive a witness plan with an explicit deciding act or closure gap, nor produce one case-level report shaped around claims and witnesses. |
| `consult` is separate from `case`. | There is no explicit policy for when project-aware context distance is enough and when the external model's different behaviour is worth its cost. |

The last point matters. A broadly worded external consultation is not a substitute for a project-aware adversarial procedure. The default for a question grounded in the current project should be a small, source-aware case when the cost is justified. A separate model remains a different kind of distance: a deliberately limited escalation, not a fictional independent adjudicator.

This proposal therefore changes neither the current runtime nor the public documentation of current behaviour. It first makes the future contract precise enough to implement and test honestly.

---

## 2. Terms and epistemic promises

### 2.1 One agent, several lenses

A **lens** is an isolated provider context of the same Cartographer agent with a different information boundary and an explicit deliverable. It is not an agent identity, role-played expert, vote, or independent source.

Use operational names only:

- **Constructor lens**
- **Blind falsifier lens**
- **Falsifier cross-examination**
- **Witness**
- **Main synthesis**

Do not write or show “the senior architect says,” “the critic won,” “three agents agree,” or similar authority claims.

### 2.2 Three different kinds of material

The case record must keep these separate:

1. **Source evidence** — captured primary material: file snapshots, line ranges, durable records, command receipts, test output, proof steps, or promoted scratch artifacts. A source has an origin, digest, capture time, and freshness statement.
2. **Claims** — a lens's interpretation, summary, candidate explanation, or proposed patch. A claim is not evidence merely because it cites a source.
3. **Witnesses** — a specific observed act that discriminates between claims: a source re-read, test, trace, reproduction, or proof check. A witness records what was observed and what it can and cannot establish.

A prior model summary is always a claim until its cited sources are checked. A source snapshot may support a claim; it never automatically decides it.

### 2.3 Evidence judgments and case dispositions

A case exposes four compact, main-context-only outcomes:

- `supported` — a named witness supports the material claim under the stated constraints;
- `refuted` — a named witness contradicts the material claim or its necessary condition;
- `unresolved` — the available evidence does not decide the claim; and
- `needs_user_input` — one precise user answer is required before an honest witness or conclusion can be produced.

The first three are evidence judgments. `needs_user_input` is a terminal **closure disposition**, not a fourth truth condition, an abstention vote, or an excuse to omit investigation. It must include the exact blocking question, why project/source evidence cannot answer it, the answer's possible effect on the witness, and the smallest successor case that would use the answer. An answer starts a successor capsule rather than silently changing the frozen one.

“Needs an approved move,” “needs a scratch experiment,” and “source unavailable” are also closure gaps or next actions. A supported or refuted material claim always names its deciding witness; a case without one must remain unresolved or end with a documented `needs_user_input` disposition.

---

## 3. Goals and non-goals

### Goals

1. Reduce anchoring on the first plausible explanation without pretending that repeated samples are independent evidence.
2. Give each lens a small, inspectable evidence capsule rather than the parent conversation.
3. Require an observable falsifier or witness instead of rhetoric or confidence language.
4. Preserve main-context authority over conclusions, durable brain updates, plan changes, and project changes.
5. Allow a future isolated experiment path without creating an ignored-project-file or `.brain/` scratch escape hatch.
6. Keep cases interruptible, finite, auditable, and cheap enough that they are deliberate rather than habitual.

### Non-goals

- No autonomous swarm, expert panel, consensus mechanism, or vote counting.
- No hidden chain-of-thought requirement or attempt to persist private reasoning. The durable output is concise, checkable material and tool provenance.
- No automatic project edit, patch application, plan change, or change-move approval.
- No arbitrary project-local `scratch/`, ignored-path, `.brain/`, or `.git/` write channel.
- No nested case, task, or external-consult recursion from a lens.
- No promise that same-model context separation produces independent judgment.

---

## 4. The intended default flow

The normal path stays deliberately small:

```text
main context selects one material uncertainty
        │
        ▼
freeze a bounded evidence capsule
        │
        ▼
constructor lens: candidate, assumptions, citations, proposed falsifier
        │
        ▼
blind falsifier lens: capsule only; separate blind counterexample hunt
        │
        ▼
seal blind artifact, then append the constructor packet to that same falsifier context
        │
        ▼
falsifier cross-examination: challenge the exact candidate and cite the result
        │
        ▼
main context receives a witness docket; it selects one witness specification,
a closure gap, or an exact user-input question — not a conclusion
        │
        ▼
concrete witness stage: source check, trace, proof, or authorised isolated experiment
        │
        ▼
main-context-only synthesis: supported / refuted / unresolved / needs user input
```

There are two analytical lenses by default, not a fleet. The falsifier's cross-examination is a second bounded step in the **same falsifier context**, not a new persona or a third opinion. The witness is an execution stage with a narrow recorded specification; it is not a vote. A further analytical lens requires the main context to record the exact unresolved claim and why the existing procedure cannot decide it.

### 4.1 Durable state machine

The eventual v2 case file should persist enough state to resume safely without rerunning a completed isolated pass:

```text
draft
  └─ capture ─▶ running/construct ─▶ running/falsify-blind ─▶ running/falsify-cross-exam
                                                                      │
                                                                      ▼
                                                     awaiting-witness-specification
                                                      │             │               │
                           main records a witness spec│             │main records a closure gap
                                                      ▼             │               ▼
                                              running/witness        │       ready-for-synthesis
                                                      │             │               │
                                                      ▼             │               │
                                              witness-recorded       │               │
                                                      └──────────────┴───────────────┘
                                                                      │
                                                                      ▼
                                                             synthesized

Any active or waiting state ── stop / timeout ──▶ stopped
```

A main-context `needs_user_input` disposition is a documented closure gap at `ready-for-synthesis`: it names the question and closes this frozen case. A later answer starts a linked successor capsule; it does not alter an already frozen one.

Rules:

- Capture freezes the capsule before the constructor request is sent.
- `falsify-cross-exam` may begin only after the blind falsifier artifact is durable. It receives construction material only through an explicit, recorded cross-examination packet.
- `awaiting-witness-specification` returns a bounded witness docket to the main context. The main may select one discriminator, record a closure gap, or identify the precise user answer needed; it may not write a final truth conclusion there.
- `running/witness` sees only the frozen capsule, the sealed structured artifacts, and the main-selected witness specification. It has no parent conversation or project-write authority and cannot synthesize a result.
- A case may become ready with no observed witness only when the main context records a closure gap, a budget limit, or a `needs_user_input` question. Its evidence judgment is normally `unresolved` unless an already recorded witness decides the material claim.
- `/case stop c<N>`, timeout, interruption, or an exhausted hard budget leads to `stopped` or a recorded closure gap. No later stage starts after terminal stop.
- Resume reuses the frozen capsule and already completed artifacts. It must never silently regenerate a supposedly blind pass.

The existing v1 `running`, `ready`, `synthesized`, and `stopped` statuses are a useful compatibility basis. v2 should use an explicit versioned schema rather than reinterpret a v1 file in place.

---

## 5. The evidence capsule

The capsule is the stable input contract, not a copy of the main context. It should contain the crux and primary material, not every thought that led to the case.

### 5.1 Required contents

```text
Evidence capsule

Crux
  Question or claim: …
  Resolution means: …
  Non-goals: …
  Constraints: …

Frozen sources
  e1 · primary · captured · src/router.mjs:44–71 · digest … · current at capture
  e2 · primary · captured · test/routes.mjs:18–29 · digest … · current at capture
  e3 · claim · captured · prior report r7 excerpt · digest … · not primary evidence

Case evidence ledger
  Observations: …
  Claims requiring checks: …
  Open source gaps: …

Hard budget
  Capsule bytes …; constructor … turns; falsifier blind/cross-exam … turns;
  witness mode …; wall-clock and artifact limits …
```

The future persisted shape can remain JSON, but needs conceptually equivalent fields:

```json
{
  "version": 2,
  "crux": {
    "question": "Does request X reach handler Y under condition Q?",
    "resolution": [
      "identify the exercised route with cited source or trace evidence",
      "name an observed discriminator between handler Y and its alternative"
    ],
    "nonGoals": ["do not redesign routing"],
    "constraints": ["no project changes in this case"]
  },
  "sources": [
    {
      "id": "e1",
      "kind": "primary",
      "status": "captured",
      "origin": { "path": "src/router.mjs", "range": "44-71" },
      "provenance": { "capturedBy": "case start", "from": "selected shelf placement sh2" },
      "catalogVersion": "when available",
      "snapshotDigest": "sha256…",
      "capturedAt": "…",
      "freshnessAtCapture": "current",
      "snapshot": "…"
    }
  ],
  "ledger": {
    "observations": [],
    "claimsToCheck": [],
    "sourceGaps": []
  },
  "budget": { "…": "policy-owned bounded values" }
}
```

`kind` states the epistemic role (`primary`, `derived`, or `claim`); `status` states the capture condition (`captured`, `stale`, or `unavailable`) without overwriting history. A summary, earlier report, or phase artifact is represented as `kind: "claim"` or `kind: "derived"`, never silently as a primary source. A durable source reference can carry its catalog identity/version; a raw file source carries canonical path, range, snapshot digest, and capture freshness.

### 5.2 Freshness and source truth

The capsule records freshness **at capture**, not a timeless assertion that a source remains current. The main context or a witness must re-read when the deciding fact depends on a source that has changed since capture.

The renderer should show source role, origin, digest, and freshness plainly. A lens must be able to say “this claim relies on an out-of-date snapshot” rather than treating a concise capsule as a source of truth by itself.

### 5.3 Capsule limits

The capsule has a policy-owned byte/token ceiling. The selection order is:

1. primary source snapshots needed to test the crux;
2. concrete constraints and resolution criteria;
3. source gaps and only the claims needed to explain why a source matters.

It must omit parent narration before omitting primary evidence. A case that cannot fit its decisive source material is not a reason to prefill the whole parent context; it is a closure gap or a reason to split the question.

---

## 6. Lens contracts and information flow

The artifacts are intentionally concise. They require checkable claims, not hidden reasoning traces.

### 6.1 Shared structured-artifact contract

Every v2 stage returns a schema-validated record and a renderer produces the readable report from that record. A free-form blob is not a valid substitute. The exact wire schema can evolve, but every version needs the following equivalent fields:

```json
{
  "artifactVersion": 1,
  "stage": "construct | falsify-blind | falsify-cross-exam | witness",
  "claims": [{ "id": "k1", "text": "…", "kind": "candidate | inference | challenge" }],
  "citations": [{ "id": "q1", "sourceId": "e1", "locator": "44-71", "digest": "sha256…" }],
  "observations": [{ "text": "…", "kind": "direct | inference", "citationIds": ["q1"] }],
  "candidate": "required for construct",
  "assumptions": [{ "text": "…", "status": "untested | contradicted | satisfied" }],
  "falsifiers": [{ "claimId": "k1", "method": "…", "expectedOutcomes": "…" }],
  "witness": { "proposal": "…", "result": "…", "receiptId": "…" },
  "closureGaps": [{ "kind": "source | budget | approval | user_input", "text": "…" }],
  "uncertainty": ["…"]
}
```

A citation points to either a frozen capsule source (`e<N>`) or a phase-local immutable read/tool receipt that records canonical origin, locator, capture time, and digest. A phase artifact or prior summary can be cited as a **claim under review**, never as primary source evidence. The harness records newly inspected source receipts in the case evidence ledger without mutating the original capsule.

The artifact validator rejects an uncited direct observation, an inference labelled direct, or a missing mandatory stage field. The case-transition validator rejects a `supported`/`refuted` synthesis without a witness receipt. It requires constructor `candidate`, `assumptions`, `citations`, `falsifiers`, and a witness proposal; blind and cross-examination challenge records; and a concrete witness result or closure gap. Stage output may be clipped for display, but the stored structured record must remain valid and preserve its original digest.

### 6.2 Constructor lens

**May see:** the capsule, its own direct project reads/searches/lists, and inputs explicitly routed from the user while it is active.

**Must return:**

```text
Candidate
  One narrow explanation, invariant, implementation option, or proof sketch.

Observed facts
  Each fact cites capsule/source ids and distinguishes a direct observation from an inference.

Assumptions and alternatives
  What the candidate needs to be true; plausible alternatives not ruled out.

Falsifier
  One or more concrete observations, tests, traces, or proof obligations that would refute or discriminate the candidate.

Proposed witness
  The smallest deciding act, expected outcomes, and what each outcome would establish.
```

It must not call the candidate confirmed or make the final truth classification.

### 6.3 Blind falsifier lens

**Initial visibility:** the same frozen capsule, not constructor prose, constructor citations, constructor conclusion, or any summary of them.

**Must first return a sealed blind artifact:**

```text
Blind attack paths
  Counterexamples, boundary conditions, conflicting call paths, missing sources, or alternate explanations investigated before construction was exposed.

Observed facts
  Cited source evidence discovered before construction was exposed.

Potential falsifiers
  Concrete discriminators and their expected results.

Unresolved source gaps
  What could not be checked from the capsule or project.
```

This artifact is written before the model can see construction material. The point is procedural anti-anchoring, not a claim that the model became independent.

### 6.4 Falsifier cross-examination

After the blind artifact is durable, the harness appends one explicit packet to the **same falsifier context**:

```text
Cross-examination packet
  Constructor candidate: …
  Constructor observations and citations: …
  Constructor assumptions: …
  Constructor proposed falsifier: …

My duty now is to challenge these exact claims against source evidence and my sealed blind pass.
I return a confirmed flaw, a failed challenge, or an exact unresolved point. I do not vote.
```

**Must return:** a citation-bearing result for each challenged material claim:

- `flaw confirmed` — what source or witness contradicts it;
- `challenge failed` — what was checked and why it did not contradict it;
- `unresolved` — exact missing source or witness.

The constructor does not receive a rebuttal loop by default. The main context, not a rhetorical exchange, chooses the witness after both artifacts exist.

### 6.5 Lens isolation rules

For all lenses:

- no project write, shared-brain write, shelf handoff, plan edit, nested task/case, `chat`, `ask`, or `consult`;
- no access to another lens's raw conversation, ambient shell window, or hidden scratch directory;
- participant input is recorded and routed with its phase/delivery provenance;
- tools and budgets are capability contracts, not hints;
- tool receipts and source citations may be included in the artifact; unsupported confidence language is not a substitute for a witness.

The current case guard in `src/harness.mjs` already proves the value of hard information boundaries. v2 should retain that property while making the artifact obligations stronger.

### 6.6 Concrete witness stage

The witness stage is not launched automatically just because two earlier artifacts exist. The main context first records one bounded witness specification from the docket: target claim, discriminator, method, expected outcomes, allowed inputs, and budget. It may also record that the witness is blocked instead.

**May see:** the frozen capsule; the sealed structured constructor, blind, and cross-examination records; immutable source receipts they cite; and the selected witness specification. It does **not** receive raw phase conversations, the parent context, an ambient shell window, or a mutable project view.

**May do:** inspect the specified source or trace with the read-only evidence tools. In a later scratch-capable implementation it may invoke one dedicated case-experiment operation only when the specification explicitly authorises it. It never receives generic `shell`, shared-brain, shelf, or project-change authority.

**Must return:**

```text
Witness result
  Witness id and target claim.
  Exact method, input source/artifact digests, and expected discriminator.
  Observed result with a source/tool/experiment receipt.
  What the result supports or refutes, if anything.
  Limits, residual uncertainty, and any closure gap.
```

A witness result is an observation, not the final outcome. It may establish neither candidate; in that event the main context records the closure gap or an `unresolved` synthesis rather than choosing the more eloquent earlier artifact.

---

## 7. Witnesses: reality decides, not agreement

A case ends its adversarial portion with a witness docket, not consensus. The main context owns the selection of the next observed act; it does not accept a lens's preferred answer merely because the lens proposed the act.

### 7.1 Main-owned witness selection

The main selects one bounded witness specification from the construction and falsifier artifacts, or records why none can run. A normal case has one witness; a second requires a recorded reason that the first result left a material discriminator unresolved.

Every specification includes:

```text
Witness id and target claim
Exact method and allowed inputs
Expected discriminator: outcome A would support …; outcome B would refute …
Budget and permitted execution surface
What result would still leave the claim unresolved
```

The selection is not a conclusion. It is a request for an observation. A receipt from a direct source read, existing trace, read-only test, or proof check uses the same witness schema whether the dedicated witness stage performs it or the main context attaches a narrowly scoped direct observation under its ordinary authority.

### 7.2 Source, trace, test, or proof witness

The default `running/witness` stage performs the specified source check, trace inspection, proof step, or permitted read-only test. It records the exact command or source location, input/source digests, exit status or observation, and what the result did **not** establish. The main context may use an existing read-only command lane only to attach the same receipt; it receives no new mutation authority from a case.

A read-only witness does not become a case-lens vote. It is an observed artifact that the main context weighs.

### 7.3 Case scratch witness

A minimal reproduction, temporary script, candidate patch, or generated fixture belongs in the future isolated scratch runner described in §8. It is available only through the witness specification and dedicated experiment interface. It cannot change the project and yields a bounded artifact plus provenance receipt, not completed work.

### 7.4 Ordinary change, closure gap, or user input

If deciding evidence requires changing the project, the case proposes an ordinary move with targets, proof, and approval semantics. The case does not bypass the change gate and that proposal is not itself a witness.

If neither a direct witness nor an approved/safe experiment is available, the main context records the exact closure gap and synthesizes `unresolved` if no already recorded witness decides the claim. If only the user can determine the condition, preference, secret, external observation, or permission that selects the witness, the main synthesizes `needs_user_input` with the precise question rather than pretending the case is a factual tie.

### 7.5 Main synthesis

The main context is the only place that says:

- which claims were checked;
- which named witness settled each material claim;
- what is supported, refuted, unresolved, or blocked on user input; and
- what must happen next.

A v2 synthesis should contain at least:

```text
Outcome: supported | refuted | unresolved | needs_user_input
Settled claim(s): …
Witnesses weighed: w1, w2 … with source/artifact digests
What was rechecked directly: …
What was rejected or remains a claim: …
Residual uncertainty / closure gap: …
Proposed next action, if any: …
```

`supported` and `refuted` are invalid without the id of a deciding witness. `unresolved` is invalid without residual uncertainty, a closure gap, or a recorded budget limit. `needs_user_input` is invalid without the exact question and successor-case boundary. “The critic won,” “two phases agree,” and “the model was confident” are never synthesis reasons.

---

## 8. Case-scoped scratch: a future isolation contract

Scratch is useful only if it remains an experiment surface rather than a project-write escape hatch. This section is a contract to satisfy before scratch code is added.

### 8.1 What it is

A scratch witness is a disposable, case-owned runtime workspace for one bounded experiment. It may hold a reproduction, temporary script, generated fixture, or candidate patch against a **read-only** source mount. Its work root is private to that witness while it runs: no other case phase, normal shell window, shelf placement, or project path can address it.

It is not:

- a project subdirectory;
- an ignored project path;
- `.brain/scratch` or a writable `.brain/` mount;
- a shell window shared with the main context or another lens;
- a route to apply a candidate patch;
- a durable cache, package environment, or hidden handoff channel.

### 8.2 Required mount and capability shape

Scratch should exist only when bubblewrap (or an equally strong replacement) is available. Direct mode and an unavailable sandbox must refuse scratch experiments rather than silently run them on the host.

A future runner should provide a fresh namespace with:

| Surface | Access |
| --- | --- |
| System toolchain | Read-only, only the declared executable/runtime paths |
| Project source | Read-only at a fixed case-source path, with a filtered projection rather than a writable live-tree mount |
| `.git` and `.brain` | **Blocked and absent** from the namespace, including beneath the source projection |
| Case work directory | Writable, fresh private directory outside the project and brain on the host |
| Home/cache | Per-case disposable location, not the existing persistent sandbox home |
| `/tmp` | Per-case temporary filesystem |
| Network | Off by default; no lens-level network exception |
| Processes | Case-owned, resource-limited, and killed with the runner |

Before launch, the harness creates a random case-owned work root under a runtime/private storage parent that is neither the live project nor `.brain`. It mounts a read-only source projection at a fixed path and overlays/omits `.git` and `.brain` so neither is reachable by normal path, `..`, symlink, or alternate mount. The source tree remains read-only even when the experiment copies files into its own work directory. The runner must not reuse ordinary session shell windows because their ambient output and lifecycle violate lens isolation.

### 8.3 A dedicated experiment interface

The future feature should use a narrow case-experiment interface rather than grant generic `shell` access to a lens. At minimum it records:

- case and witness identifiers;
- exact command or script content;
- source/capsule/artifact input digests;
- start/end time, exit status, timeout, and resource-limit result;
- bounded stdout/stderr with their digest;
- manifest and digests of declared output artifacts;
- whether cleanup or controlled retention occurred.

The interface has hard command, wall-clock, CPU, memory, process-count, output, file-count, and storage bounds. A storage bound must be mechanically enforceable before implementation; “check the directory after it grew” is not the promised isolation contract.

### 8.4 Retention and cleanup

The default is destruction when the witness or case ends. A lens may propose an output for retention, but cannot write it into `.brain/` itself.

Only the harness may perform a controlled promotion after validating a size/type/manifest bound. The retained item becomes an immutable case artifact under the durable case record with:

- a content digest;
- the experiment receipt and command;
- input source digests;
- logical artifact name and media type;
- a statement that it is experimental material, not a project change.

On normal completion, stop, timeout, and startup recovery, Cartographer removes only directories in its own case-scratch root. It never broadly cleans `/tmp` or a project-local folder. A failed cleanup is reported as a cleanup failure, not silently forgotten.

### 8.5 Candidate patches

A scratch candidate patch may be retained as a diff artifact. It never applies itself to the project. Its case result can propose:

> Candidate patch artifact `a3` changes `src/foo.mjs`; reproduction `w2` supports it. No project file changed. Next step: declare an ordinary move for `src/foo.mjs` with proof `…`.

The ordinary move, approval, checkpoint, changed-surface gate, and acceptance process remain the only route to a real project change.

---

## 9. Model distance: the role of `consult`

The external `consult` lane (currently the Mythos-nano supplied-context consultation) and a same-model case provide different kinds of distance.

| Mechanism | Gives | Does not give |
| --- | --- | --- |
| Bounded deliberation case | Current project access, source citations, controlled anti-anchoring, tests/traces/witnesses, reproducible project evidence | Independent model judgment |
| `consult` | Different model behaviour and a sealed outside pass over a supplied packet | Project access, tools, current source visibility, or authority over the project |

This proposal does not remove or reimplement `consult`. Its eventual decision rule should be deliberate:

- use a project-aware case when the material uncertainty is about current source, behavior, or evidence that Cartographer can inspect;
- consider `consult` for a compact, self-contained hard kernel, a formal argument, a genuinely unresolved disagreement after a clean case packet, or a last outside critique where different model behaviour is worth the swap and prefill cost;
- treat external output as an advisory claim packet to verify, never as independent evidence or a tie-breaking vote.

A case phase continues to be forbidden from calling `consult`. The main context can assemble a bounded external packet only after deciding that model distance is useful.

---

## 10. Reports, UI, and user control

### 10.1 One case-level report

There should be one meaningful durable report for a completed or stopped case, not one report per lens. The raw lens conversations remain in the Durable transcript for audit; the report retains only checkable results:

1. crux and resolution criteria;
2. frozen sources and capture freshness;
3. constructor candidate and assumptions;
4. blind falsifier result and cross-examination result;
5. observed witness or closure gap;
6. main synthesis and residual uncertainty;
7. retained scratch artifacts, if any;
8. proposed but unapproved move, if any.

The report must name source and witness identifiers rather than duplicate large snapshots. It is a case record, not a transcript-shaped persona debate.

### 10.2 Visible state

The existing `/case` surface is the right foundation. A future UI should show:

- case question and resolution criteria;
- selected source ids, digest/freshness, and whether a source is primary or merely a claim;
- active phase, including an explicit `blind: construction hidden` indicator;
- hard budget consumption and any current closure gap;
- witness state: pending, running, observed, unavailable, or stopped;
- scratch availability and its isolation status when relevant;
- user-message delivery route; and
- the final outcome with witness ids, never phase count; or, for `needs_user_input`, the exact blocking question and successor-case boundary.

The user can inspect and stop a case at every stage. A case must not obscure that a witness command is running or that a candidate patch exists only outside the project.

---

## 11. Migration and implementation sequence

### 11.1 Compatibility

Existing v1 case files remain immutable historical records. A v2 parser/renderer must recognize their version and preserve their current meaning; it must not invent resolution criteria, cross-examination, scratch artifacts, or a witness outcome that did not occur.

New v2 cases use a new schema version and explicit phase/subphase records. A migration is optional only if it can preserve provenance exactly; otherwise old cases remain v1.

### 11.2 Extend `case`; do not create a parallel deliberation tool

The existing `case` entry point is the compatibility and UI anchor. v2 should extend it rather than add `deliberate`, `panel`, or another competing durable record type:

| Existing surface | v2 treatment |
| --- | --- |
| `case start` | Creates a v2 capsule and runs only through the sealed cross-examination boundary; it returns a witness docket instead of silently interpreting it. |
| `case resume` | Continues an interrupted durable stage only. It cannot replay a completed blind pass or replace a frozen capsule. |
| New `case witness` action | Accepts the main-owned structured witness specification, starts the constrained witness stage, and records its receipt or closure gap. It is not generic shell access. |
| `case synthesize` | Remains main-context-only and adds the explicit `needs_user_input` disposition with its required question/successor boundary. |
| `/case`, `/case c<N>`, `/case stop c<N>` | Keep their inspection and stop roles, rendering v1 or v2 according to schema version. |

This is an interface proposal, not a request to change the current action schema. A v1 `start` continues to mean its present three-phase behavior until a versioned v2 start contract is implemented; no existing case is silently reinterpreted.

### 11.3 Recommended sequencing

1. **Accept this design and add schema-only tests.** No behavioural change until the information-flow and artifact contract are agreed.
2. **Capsule and structured artifacts.** Add v2 capture/rendering, source roles/freshness, resolution criteria, and constructor/blind-falsifier schemas. Preserve v1 reader support.
3. **Blind-to-cross-exam transition.** Persist the blind artifact, then inject the recorded constructor packet into the same falsifier context. Test that construction is absent before this point.
4. **Main-owned witness selection, structured witness stage, and case-level report.** Add witness specifications, direct-witness/closure-gap records, and a synthesis that cites them. Do not add scratch yet.
5. **Isolated scratch runner.** Build only after its mount, resource, cleanup, retention, and direct-mode refusal contract can be tested mechanically.
6. **Consult positioning and benchmark.** Adjust call-selection guidance only after measuring the case against ordinary investigation and model-distance alternatives.

Each stage should be separately useful, bounded, and verified offline. No stage should claim improved model judgment merely because it changes a prompt.

---

## 12. Verification and benchmark plan

### Offline mechanics

The suite should prove procedure and confinement, including:

- a blind falsifier request contains the capsule but no constructor text, citations, digest, or summary;
- the cross-examination packet is sent only after the blind artifact is durably recorded;
- the witness stage receives only its docket, selected specification, and immutable cited receipts — not the parent conversation or an ambient shell;
- a resumed case does not rerun completed constructor, blind, or cross-examination work;
- every structured artifact rejects uncited observations, missing resolution criteria, mandatory candidate/assumption/falsifier fields, or an invalid witness receipt;
- a synthesis cannot derive support from artifact count; `supported`/`refuted` require a named witness, `unresolved` requires a closure/budget record, and `needs_user_input` requires its exact question and successor boundary;
- a v1 file still renders as v1 without fabricated v2 fields;
- an experiment cannot read or write the project outside its read-only projection, discover `.git` or `.brain`, or reach the network;
- direct/no-sandbox mode refuses case scratch rather than degrading confinement;
- output, time, CPU, memory, process, command, artifact, retention, and cleanup limits are exercised; and
- a promoted candidate patch remains an artifact and cannot alter the project without an ordinary move.

### Comparative evaluation

Use a fixed fixture set with known source-level answers, runtime failures, and boundary cases. For each question, record the exact source packet and compare:

1. ordinary main-context investigation;
2. bounded same-model deliberation;
3. a supplied-context external consultation;
4. a hybrid where model distance is used only after a real unresolved case.

Measure only things that can be observed:

- source-citation fidelity and digest validity;
- useful counterexamples found;
- witnesses attempted and successfully discriminating;
- false-confidence rate against known ground truth;
- unresolved cases correctly left unresolved, and user-input dispositions used only when the recorded question truly controls the next witness;
- wall-clock time, model swaps, request/prefill tokens, completion tokens, and scratch resource use.

A live run remains an observation of one model/session/project unless and until the measurement decision in `docs/design.md` changes. The benchmark does not turn a small sample into proof of general model independence.

---

## 13. Open decisions before implementation

1. **Witness authority:** which existing read-only commands count as direct witnesses, and does starting a scratch witness need an additional explicit user-facing confirmation?
2. **Hard budgets:** exact capsule, lens-turn, runtime, output, artifact, and resource limits need calibration against the current test suite and real fixture costs.
3. **Scratch storage enforcement:** choose a genuinely enforced disk/storage mechanism before exposing the feature.
4. **Artifact retention:** define size/type limits and whether retained artifacts live only under case provenance or may be promoted to another durable record type.
5. **Report integration:** decide whether a synthesized case always mints a standard report id or whether the case file remains the single durable report surface.
6. **Escalation threshold:** establish, through the benchmark, when the extra cost of `consult` has enough expected value to justify a model swap.
7. **User-facing naming:** retain the concise `case` API if possible; any label should describe a bounded evidence procedure rather than suggest a simulated team.

## Recommended next decision

Approve or amend the v2 information-flow contract first: capsule schema, blind-then-cross-exam sequence, main-owned witness rule, and scratch non-negotiables. The next code change should be the smallest schema/structured-artifact stage, not a scratch runner or a broader prompt rewrite.
