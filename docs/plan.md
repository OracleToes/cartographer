# Cartographer delivery plan

**Status:** active roadmap. Atlas attention is closed as the verified baseline; the
same-model `consult` conference is the next proposed runtime program.
**Date:** 2026-11-16
**Scope:** sequencing, consolidation choices, and go/no-go gates. This document does
not authorize runtime changes by itself.

The former Case/staging delivery track is no longer a living agenda. Delivered work is
preserved in Git and durable records; unfinished Case scratch and escalation work was
deliberately dropped. This plan replaces that track with the surviving product order:

```text
Atlas attention closeout (complete)
→ same-model consult conference (not started)
→ one migration and cutover that removes overlapping legacy products (not started)
```

## 1. Documentation roles

Each living document has one job. Keeping these roles separate prevents the plan from
becoming a second implementation specification or the README from describing software
that has not shipped.

| Document | Job | Current status |
| --- | --- | --- |
| [`design.md`](design.md) | Durable product intent, boundaries, and settled decisions. | Retained source of intent. |
| [`atlas-attention.md`](atlas-attention.md) | Focused implementation record and offline evidence for the surviving Atlas-attention feature. | Verified baseline. |
| [`consult-mode-proposal.md`](consult-mode-proposal.md) | Target contract, isolation model, migration invariants, and detailed acceptance evidence for the replacement consultation feature. | Approved design; not implemented. |
| `plan.md` | Delivery order, explicit consolidation choices, and transition gates. | This active roadmap. |
| [`../README.md`](../README.md) | Behavior the current runtime actually ships. | Retains the legacy Case and external-consult descriptions until cutover changes the runtime. |

Historical phase plans, Case artifacts, and prior proposals remain useful evidence in
Git history and migrated archives. They are not another current roadmap.

## 2. Parallel-system audit

Systems should be combined only when doing so removes a genuinely overlapping product
and lifecycle. Similar vocabulary alone is not a reason to make a generic framework.

| Surface | Decision | Why |
| --- | --- | --- |
| Atlas attention in state, terminal, and screen | **Keep as-is.** | It already uses the shared `attentionSnapshot()` and `renderAttention()` projection. A further merge would only blur the deliberate stable-top/fresh-tail context boundary. |
| Current external `consult` plus `story` transcript storage | **Replace at cutover.** | It is a second consultation model, configuration path, request path, transcript format, shelf resolver, and UI path. The future conference supplies the one surviving consultation meaning. |
| Evidence `case` product | **Retire at the same cutover.** | It overlaps the conference's bounded isolated deliberation purpose but carries a much larger lifecycle: capsules, blind/cross phases, witnesses, artifacts, and a separate UI/return path. Reusing that machinery would keep the duplicate product alive. |
| Future same-model conference | **Keep as the sole consultation surface.** | It combines the useful parts—same-model reasoning, bounded input, isolation, auditable turns, and a final return—without importing Case ceremony or an external model. |
| Normal task, change staging, shell windows, and checkpoints | **Keep separate.** | They have project-change authority and a safety contract. A consultation is advisory and must not acquire that authority as “scratch.” |
| Shelf/catalog working memory and consult entry snapshots | **Keep separate, with a narrow bridge.** | Shelf is a live, user-visible working set; conference sources are frozen, consult-local evidence. A generic snapshot/provenance system would add machinery before a second surviving use needs it. |

The meaningful consolidation is therefore one deliberate transition:

```text
external consult + story lifecycle + Case lifecycle
                         ↓
                  one consult conference
```

It is a replacement, not a compatibility layer or a merger of every internal utility.

## 3. A0 — Atlas-attention closeout

**Status:** complete; no new runtime slice is planned.

Atlas attention has the right level of consolidation already:

- durable map claims remain separate from bounded derived attention;
- factual observations produce heat, while declared move targets are temporary active
  overlays;
- mapping gaps render separately from stale/broken-node checking pressure;
- state, terminal, and screen share one fresh attention projection; and
- archive is reversible; permanent removal remains a direct-inspection operating
  protocol, not a receipt or provenance subsystem.

[`atlas-attention.md`](atlas-attention.md) records the implementation and the evidence:
`npm run test:unit` passed 111 checks, and `npm run test:ported` passed 69 checks with
two unrelated Bubblewrap skips. No Atlas code should be changed merely to create a new
receipt, generic verification framework, or another attention consumer.

**Exit condition:** met. Atlas is the verified baseline for the rest of this roadmap,
not a pending prerequisite or a parallel redesign.

## 4. C1–C5 — Same-model consult conference

**Status:** design approved; runtime implementation awaits explicit authorization.

The detailed contract and testable behavior live in
[`consult-mode-proposal.md`](consult-mode-proposal.md). These milestones own order and
cutover gates rather than duplicating its record schemas or prompt text.

### C1 — Provider capability gate

Before building a routing product, demonstrate through the configured provider adapter
that it can enforce a finite enum grammar for the neutral selector. A completion prefix
or voluntary model tool call is not enough.

**Gate:** if that capability is unavailable, fail explicitly and return to design. Do
not quietly downgrade to unconstrained routing or retain the old external model as a
fallback.

### C2 — Consult-local capture and isolation

Create the independent same-model Durable child and its small `co<N>` record, capture
caller context/files and one entry-time snapshot per book persona, and expose only
consult-local source access. `myPersona` opens the conference; empty books remain valid
personas.

**Gate:** snapshots must remain immutable after entry, paths/ranges must stay confined,
and the child must not inherit live parent/project/brain authority.

### C3 — Turns, selector, and stable prefill

Add the versioned roster, request-local persona tails, host-owned grammar-constrained
selector, participant-labelled history, and no-consecutive-speaker enforcement.

**Gate:** participant → selector → participant handoffs must preserve the common
provider prefill and append-only shared conference history. A reset, fork, compaction,
or rebuilt common request is an invariant failure.

### C4 — Return, recovery, and audit UI

Add the restricted `consult_source` and `consult_return` surface, cancellation/restart
and limit outcomes, caller-facing final result, and conference audit view. Keep the
private structured notebook inspectable without leaking it by default into parent chat.

**Gate:** any participant can return; malformed returns leave its speaker active;
limits and failures never fabricate synthesis; the conference remains advisory with no
project or shared-brain write authority.

### C5 — One migration, then deletion

Only after C1–C4 pass their end-to-end acceptance evidence, execute the migration in
[the proposal's consolidation section](consult-mode-proposal.md#consolidation-and-migration):

1. inventory legacy storyteller records, shelf placements, Case records, and active or
   resumable Case children;
2. block an unsafe active Case rather than orphaning it;
3. archive original legacy bytes/digests with static readable exports and migrate
   storyteller shelf content to ordinary text snapshots;
4. reject old `thread` calls and external-consult settings explicitly; and
5. remove the external consult, live story parser/renderers, Case vertical, related
   policy/config/harness/UI/prompt code, documentation, and tests in the same cutover.

**Gate:** a fresh install must expose one `consult` contract and no `case`; migrated
legacy material must remain readable without a live legacy parser; no archived material
or second configured model may enter a conference request.

## 5. Explicit non-work

- No C4 executable or Case scratch runner, and no E1 product-selection benchmark.
- No permanent legacy adapter, story reader, Case reader, or second meaning of
  `consult`.
- No generic persona, snapshot, finite-choice, receipt, provenance, or archive
  framework before another retained product demonstrates the need.
- No merge of consultation with task staging, shell windows, or change authority.
- No README rewrite before behavior changes; it must remain honest about the current
  external consult and Case runtime.
- No runtime implementation, deletion, or migration merely because this plan exists.

## Next action

Atlas closeout is complete. When the user authorizes implementation, begin **C1**, the
provider grammar-capability gate, then proceed through C2–C5 in order. Do not remove
legacy systems early or preserve them indefinitely “just in case.”
