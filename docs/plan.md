# Cartographer delivery plan

**Status:** current verified plan and proposed slices, 2026-11-17.

`docs/design.md` is the recorded source of intent. It is not a live delivery plan or a changelog. `README.md` describes the shipped harness. This document is the one place for verified implementation status, the remaining work, and the order in which new work may be taken. Git history retains the superseded working proposals and completed slices.

“Verified” below means inspected source, offline tests, and commit history—not a claim about a live model session or a provider's hidden prompt.

---

## 1. Audit: what exists now

The former working documents describe several different pieces of work. Their status is not the same.

| Material folded here | Verified state | Evidence in the current tree | Plan disposition |
| --- | --- | --- | --- |
| Talk, Work, Model, request snapshots, and truthful mutations | Shipped through the former four implementation stages | `planRequest()` separates pure planning from send effects; `engine.sending()` freezes provider payloads; the Model views separate Sent, Since, Raw payload, Preview, and current accounting; Talk uses Durable identities rather than equal text. | Baseline, not an active feature slice. |
| State-led dispatch, focus capsules, and normal writable-command staging | Shipped | Main-only `Dispatch` is in `src/state.mjs`; focus projection and captured shelf evidence are in `src/request.mjs`, `src/context.mjs`, and `src/tools/task.mjs`; direct file operations have atomic changed-surface accounting in `src/tools/change.mjs`; `src/stage.mjs` materializes a disposable command candidate and promotes it only through the live move gate. | Baseline. Direct mode remains intentionally detection-only. |
| Bounded evidence cases | v1 is shipped; v2 is not implemented | `src/case.mjs` and `src/tools/case.mjs` persist a frozen capsule, construct → blind falsify → source-only witness phases, stopping/resume, and main-only synthesis. | The active future workstream, C1–C4. |
| Long-form external consultation | Shipped as a separate, supplied-context advisory lane | `consult` wording, durable thread handling, screen rendering, and tests are current. | Keep it distinct; evaluate an explicit escalation policy only in E1. |
| Atlas heat and focus | Shipped | `src/atlas.mjs`, `src/state.mjs`, and coverage for direct-hot, warm, care, mapping gaps, and reversible archive candidates. | Baseline. The stale public “not here yet” claim is removed with this consolidation. |

The audit is backed by the following implementation commits, in addition to the current source and tests:

- `9609a76` — frozen provider-request snapshots;
- `5621fdf` — pure request planning before provider formatting;
- `ab56bd8` and `2e09ea9` — Talk/Work separation and stable Durable-source mutation;
- `85897d1`, `f7bbb74`, and `6757d80` — Dispatch, focus capsules, captured shelf evidence, and symmetric direct changed-surface accounting;
- `94d4d8e` and `04293ec` — evidence-case v1 and its lifecycle hardening; and
- `1642852` — long-form `consult` clarification without conflating it with same-model case work.

The current offline suite passes **103 unit tests and 67 ported integration tests**. One bubblewrap confinement test is skipped on machines without bubblewrap; it is not treated as a passing sandbox observation.

### 1.1 What is deliberately not claimed as complete

The remaining safety/evidence gap matters more than another prompt rewrite:

1. **Case v2 is a design contract, not runtime behavior.** Current cases do not enforce structured artifacts, do not conduct a post-blind cross-examination, cannot execute a test/trace/reproduction as a witness, have no disposable scratch space, and have no benchmark-backed `consult` escalation rule.

Sandboxed normal change commands now use a per-focus disposable source stage. Its candidate diff is validated against the current approved move, source digest, targets, operation/surface limits, and checkpoint path before promotion; direct mode remains explicitly user-selected detection-only execution. This stage is not case scratch and supplies no case authority.

Plugins, durable transcript/catalog pruning, and the measurement decision for live 27B sessions remain parked. They are not silently promoted into this plan.

---

## 2. Invariants every slice keeps

The design intent and shipped harness establish these boundaries. A slice that needs to weaken one stops for an explicit decision rather than smuggling it in.

1. **One agent, not a simulated team.** A focus or case lens is the same Cartographer under a different information boundary. It is not an expert, voter, independent corroborator, or authority source.
2. **The main context owns project judgment.** It selects work, changes the plan, accepts move reports, chooses whether case evidence settles a claim, and decides whether model distance is worth requesting. Isolated contexts return bounded artifacts and observations.
3. **Authority stays where it is.** A declared move, exact revision, approval mode, target list, capabilities, checkpoints, proof, acceptance, and undo remain the only route to a project change. A handoff, case artifact, scratch patch, or consultation never applies a change.
4. **The brain is durable; the provider request is a finite cache.** Sent payloads are frozen historical records; previews are explicitly unsent; current brain records are never rendered as historical request content.
5. **Provenance beats prose.** Sources, snapshots, artifacts, command receipts, user input, and closure gaps carry stable identities/digests and a lifecycle. A summary remains a claim until its source is checked.
6. **No ambient side channel.** A case phase cannot use the shared shelf, brain, shell windows, nested work, or `consult` to smuggle information across its intended boundary.
7. **Do not misdescribe confinement.** Direct-file scope and sandboxed normal command promotion are preventative; user-selected direct command mode remains detection-only. Case scratch is unavailable until C4 ships; it must refuse rather than silently degrade to host execution.
8. **Offline mechanics first.** Every slice proves its own data flow and authority boundaries in the bounded test suite. A live run is a deliberately labelled observation, never a general model-quality pass.

---

## 3. Delivery shape

A slice is one reviewable, reversible unit with one authority surface. It includes its schema/renderer, tests, public wording where behavior changes, and an explicit closure condition. It does not bundle “while here” redesigns.

The work has two independent tracks until their controlled-execution requirements meet:

```text
Safety track:  S1 contract ─▶ S2 normal writable-command staging

Case track:    C1 v2 capsule/artifacts ─▶ C2 blind-to-cross flow ─▶ C3 witness/report/UI ─▶ C4 isolated scratch

Evidence track:                                                  E1 benchmark and consult policy
```

C1–C3 need no scratch runner and can proceed without S2. C4 may reuse only a **proven** low-level isolation primitive from S2; it may not inherit S2's broader normal-change authority or persistent home. If no such primitive can satisfy C4's stricter contract, C4 uses a separate runner.

### Common exit gate

Before a slice is called done:

- its exact behavior is covered by unit/integration tests under the existing ten-second budget;
- `npm test` and `git diff --check` pass;
- v1 durable files and existing public behavior remain readable unless a versioned migration says otherwise;
- prompt, README, and screen wording make only claims the code can enforce; and
- any live experiment is recorded as one observed session/model/project, separately from offline acceptance.

### D0 — Consolidate the working record

**Status:** completed by this documentation change; no runtime behavior changes.

Retain `docs/design.md` as intent, create this single current plan, and retire the now-conflicting information-architecture, dispatch, and case-v2 working proposals. Correct public documentation where the audit found a shipped feature still described as absent. Git history preserves the detailed predecessor documents and the commits that implemented their shipped portions.

**Exit evidence:** no link points at a retired plan; `docs/design.md` points here for current delivery status without treating its historic decisions as a tracker; README no longer lists shipped graph heat/focus as absent; the repository has one current planning document.

---

## 4. Safety track — make writable command scope honest

### S1 — Specify the normal writable-command staging contract

**Status:** accepted 2026-11-16; this is the contract S2 implements. No runtime behavior changed in S1.

The goal is to turn the existing “compare the final checkpoint diff” detection into a pre-application gate for sandboxed command moves. This is not case scratch and must not be disguised as one.

1. **One stage per change focus.** On a sandbox-capable change focus, Cartographer makes one random, case-unrelated stage root under an OS-private runtime parent, never inside the project or `.brain`. It contains a bounded materialized project copy (`work`), a fresh home/cache, and a fresh temporary directory. The source copy excludes `.git` and `.brain`; neither becomes a writable alternate path.
2. **The command's only writable project-shaped path is `work`.** The command starts in that path. The live project remains reachable, if at all, only through bubblewrap's read-only system view; stage home and temporary paths are private to that move. Network remains exactly the approved move capability. Existing output/time limits remain in force; S2 adds fixed file-count and storage limits before a stage can be used.
3. **The stage is a candidate, not a mutation.** Cartographer snapshots the source manifest before the first command. At task end it first closes every stage-owned window, then computes a bounded candidate manifest/diff from `work`. A candidate carries source/stage digests, commands, output/exit receipts, and cleanup result. It is not a project change merely because a command exited zero.
4. **Promotion is the existing authority path.** The harness validates every candidate path against the live current move, original source digest, target list, changed-surface allowance, file-operation ceiling, text/binary policy, and checkpoint precondition before it touches the live tree. It validates the whole candidate before writing; an apply failure rolls back the already-applied paths or reports a rollback failure as fatal. A successful promotion is what the task's normal after-checkpoint records.
5. **Refusal is safe and durable.** An oversized, stale, out-of-target, malformed, or resource-exceeded stage is discarded without applying a partial diff and becomes a precise closure gap/command record. Normal completion, stop, timeout, restart recovery, and failed promotion remove only the stage root Cartographer created.
6. **Direct mode remains honest.** User-selected `--no-bwrap` / direct command moves retain their current detection-only behavior and explicit warning. They never receive a false “staged” claim. Main-context read-only commands continue to require bubblewrap.

**Exit evidence:** negative tests are designed before the runner: no live-project write, no brain/git bypass, no undeclared network, no diff application outside the ordinary move gate, and no leftover stage directory after normal, stopped, timed-out, or refused work.

### S2 — Implement sandboxed command staging and promotion

**Status:** completed 2026-11-17.

`src/stage.mjs` creates an OS-private, random disposable work root for each sandboxed change focus. `src/tools/shell.mjs` routes its commands only to that stage; `src/windows.mjs` mounts the stage at `/work`, gives it a fresh home, hides the live brain/git paths, and makes any dependency overlay read-only. `src/tools/task.mjs` closes all stage-owned windows, records the bounded candidate manifest and receipts, rechecks the live approved move and source manifest, validates targets/operation/surface/file rules, then promotes the complete candidate or records a closure gap before checkpointing. The task report retains the staging receipt; direct mode remains clearly detection-only. Dead-process stages are cleaned on the next session start.

The implementation does not broaden the command API or create a project-local scratch folder. It does not treat an exit status as a project mutation.

**Verified exit evidence:** portable unit fixtures prove no live-tree mutation before promotion, blocked `.brain`/`.git` candidate paths, target and stale-source refusal, source/diff bounds, atomic rollback, and cleanup. A bubblewrap integration fixture checks the actual staged mount and is explicitly skipped on this machine because `bwrap` is unavailable; it is not claimed as a local confinement observation. `npm test` passed with 107 unit tests and 67 ported integration tests; two bubblewrap checks skipped; total 9.0 seconds under the ten-second budget.

---

## 5. Case track — bounded deliberation v2

The existing `case` tool is the compatibility anchor. Do not create `deliberate`, `panel`, or a competing case database. v1 files remain historical records; a v2 reader/renderer must never fabricate fields that a v1 case did not have.

### C1 — Versioned capsule and structured artifacts

**Status:** proposed implementation slice. No scratch and no cross-examination yet.

Add a v2 case schema whose frozen capsule contains only the material needed to test one narrow crux:

- question/claim, resolution criteria, constraints, and non-goals;
- frozen source entries with role (`primary`, `derived`, or `claim`), capture status, origin/provenance, locator, digest, capture time, and freshness at capture;
- an evidence ledger that distinguishes observations, claims requiring checks, and source gaps; and
- policy-owned capsule, phase, artifact, and storage budgets.

Require schema-validated phase artifacts rather than clipped free-form reports. They need equivalent fields for candidate, observations, assumptions, citations, falsifiers, proposed witness, closure gaps, and uncertainty. A direct observation cites either a frozen source or an immutable phase-local tool receipt. A prior report or phase artifact can be cited as a claim under review, never silently promoted to primary evidence.

The new schema stores a readable rendering plus structured data and its digest. Display clipping never makes the stored record invalid. Newly inspected source receipts append to the case ledger without mutating the frozen capsule.

**Exit evidence:** v1 files render unchanged; v2 rejects malformed resolution criteria, uncited direct observations, missing mandatory fields, oversized capsule/artifact input, and source-role confusion; a resume sees the same frozen inputs and completed artifacts.

### C2 — Blind pass, controlled cross-examination, and durable transition

**Status:** depends on C1.

Replace the v1 fixed middle with an explicit information-flow state machine:

```text
construct
  → falsify-blind
  → falsify-cross-exam
  → awaiting-witness-specification
  → witness | documented closure gap
  → ready-for-synthesis
```

The constructor supplies a narrow candidate, assumptions, citations, falsifiers, and a proposed witness. The blind falsifier initially receives the same capsule but no constructor prose, citations, digest, or summary. Its blind artifact is sealed before the harness appends a recorded constructor packet to that **same** falsifier context. The resulting cross-examination has to mark each challenged material claim as a confirmed flaw, failed challenge, or exact unresolved point with citations.

The constructor receives no default rhetorical rebuttal loop. A case remains one agent under controlled visibility, not a debate or vote. Case phases remain blocked from shell windows, shared-brain/shelf writes, nested work, `chat`, `ask`, and `consult`.

**Exit evidence:** request fixtures prove the blind boundary byte-for-byte; the cross packet appears only after durable blind storage; stop/timeout/resume cannot start a later phase or regenerate a recorded blind pass; phase count cannot produce a truth outcome.

### C3 — Main-owned witness, synthesis, report, and visible state

**Status:** depends on C2; still no scratch execution.

After cross-examination, the main context receives a bounded witness docket. It records exactly one witness specification—or a closure gap—before the witness stage runs. A specification names target claim, method, allowed inputs, expected discriminator, budget, and what result would still be unresolved.

The witness stage sees only the capsule, sealed structured artifacts, cited receipts, and specification. It may perform a specified read/source/trace/proof check and produce a receipt. It cannot read the parent conversation, use a generic shell, mutate the project, or synthesize the outcome. A narrowly scoped main-context direct observation may use the same witness schema; it gains no new authority from the case.

Main-context synthesis is the only point with these outcomes:

- `supported` or `refuted`, each naming the witness that settles every material claim;
- `unresolved`, with residual uncertainty, a closure gap, or a budget limit; or
- `needs_user_input`, with an exact blocking question and a linked successor-capsule boundary.

Produce one durable case-level report, not durable persona chatter. `/case` and the screen expose capsule source roles/freshness, current subphase, the blind boundary, budget use, participant routing, witness state, closure gaps, retained artifacts, and final witness ids. A candidate patch is visibly outside the live project.

**Exit evidence:** a supported/refuted synthesis without a witness is refused; `needs_user_input` cannot omit its exact question; the report never treats agreement as corroboration; v1 inspection and `/case stop` remain compatible; screen/terminal tests show the same durable state.

### C4 — Isolated case scratch witness

**Status:** depends on C3 and a proven confinement design; highest-risk implementation slice.

A scratch witness is a disposable experiment surface, not a shell window and not a candidate project change. It is available only through a main-owned witness specification and one dedicated experiment operation.

Its non-negotiable contract is:

- fresh private work root outside the project and `.brain`;
- read-only source projection at a fixed path, with `.git` and `.brain` blocked/absent even below that projection;
- per-case disposable home/cache and `/tmp`, network off by default, case-owned processes, and enforced time/CPU/memory/process/output/file/storage limits;
- command/script, input source/capsule/artifact digests, output, exit/resource status, declared artifact manifest, and cleanup result retained as provenance;
- default destruction at completion/stop/timeout/recovery; only the harness can promote a bounded immutable artifact under the case record; and
- no automatic project application. A retained candidate patch is only evidence for a later ordinary move.

Direct mode or an unavailable strong sandbox refuses scratch rather than using the host. The generic `sandboxArgs()` path and persistent session windows do not satisfy this contract as they stand.

**Exit evidence:** automated confinement checks prove no project write, no `.git`/`.brain` visibility, no network, no access from another case/window, enforced resource limits, receipt/artifact digest integrity, cleanup reporting, and promotion-only candidate patches.

---

## 6. Evidence track — measure before changing escalation policy

### E1 — Offline benchmark and `consult` selection rule

**Status:** depends on C3 for a meaningful case comparison; C4 is optional for the first source-only fixture set.

Build a fixed offline fixture corpus with known source answers, runtime failures, and boundary cases. For the exact same bounded source packet, compare:

1. ordinary main-context investigation;
2. bounded same-model case work;
3. supplied-context external `consult`; and
4. a hybrid that escalates only after a real unresolved case.

Measure source-citation/digest fidelity, useful counterexamples, witness attempts and discrimination, false confidence against known ground truth, correct unresolved/user-input outcomes, wall-clock time, model swaps, request/prefill tokens, completion tokens, and scratch resource use where applicable.

The result informs call selection, not a claim that separated same-model contexts became independent. Until then, the current boundary holds:

- use a case for project-grounded uncertainty that Cartographer can inspect;
- use `consult` deliberately for a compact self-contained hard kernel, formal argument, unresolved clean case packet, or outside critique where different model behavior is worth its cost; and
- treat external output as an advisory claim packet to verify, never a tie-breaking vote or project authority.

Only benchmark evidence may justify a broader prompt or README recommendation about when to invoke `consult`.

**Exit evidence:** reproducible fixtures, exact packets, recorded metric definitions, and a report that labels any live session as observation rather than general acceptance.

---

## 7. Parked decisions and explicit non-work

These items remain visible so that they are not accidentally reintroduced as “obvious cleanup.” They are not approved implementation slices.

| Item | Why it is parked | Required decision before work |
| --- | --- | --- |
| Transcript/catalog/index retention and pruning | It changes the durability/recoverability contract. | User decision on retention, deletion, export, and recovery semantics. |
| Plugins | It broadens the harness's authority surface. | Separate plugin trust and lifecycle design. |
| Live-model measurement gate | Offline mechanics can pass without making model-quality claims. | Decide whether a live 27B run is observational only or may be acceptance evidence. |
| Exact case/scratch budgets and scratch confirmation | They need fixture cost and user-control calibration. | Establish through C1/C3 fixtures and the S1/C4 contracts. |
| Persistent request audit beyond this run | Current Model inspection is deliberately in-memory; wire tracing is opt-in. | Retention/privacy decision, not a screen convenience change. |

---

## 8. Documentation ownership after consolidation

- `docs/design.md` remains the recorded intent. Do not use it to track implementation completion; change it only when the user changes intent.
- `docs/plan.md` is this verified delivery plan. New active work, its evidence, status, dependencies, and staged slices go here.
- `README.md` describes behavior already shipped. It must not promise an unimplemented slice.
- Source, tests, and git history are the proof of implementation. The prior working proposals are intentionally retired rather than maintained as competing status records.

## Next slice

S1–S2 are complete. Continue with C1's versioned case capsule and structured artifacts, preserving readable v1 records and without adding scratch execution or cross-examination ahead of their own slices.
