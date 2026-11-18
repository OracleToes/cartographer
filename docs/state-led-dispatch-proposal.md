# State-led dispatch and focus capsules

**Status:** proposal, not implemented. 2026-11-16.

`docs/design.md` remains the source of intent. This is a working proposal for the next change to that design; it makes no live-model claim.

## Decision in one sentence

Use the fresh state tail to help the main context decide the next delegation, then give a focus a deliberately selected capsule of evidence and boundaries rather than the main context's whole planning environment.

The main context remains the one mind that reasons over the project. A focus remains the same mind in a temporary working context. The harness changes what each sees, not who is making the decision.

## Intent recovered from the design

The original direction already points here:

- Context is finite working memory; the brain is durable project memory.
- The state block is the one live, trusted view.
- The agent, not a second worker or hidden scheduler, manages its own attention.
- A focus is an attention firewall chosen for one narrow question or one declared change, not a toll booth.
- The user approves exact moves; envelopes are intent, never general clearance.
- Atlas, ledger, reports, and shelf material exist to make later work better informed.

The present system has those pieces. Its weak point is the handoff between them. A broad move action, the full parent conversation, the full live state, and a small file-operation count arrive together in a focus. That asks the focus to rediscover both its local job and the rest of the feature, then rewards it for compressing work into one mutation.

The answer is not a second durable plan of cards, spans, and leases. That would duplicate the plan, atlas, ledger, reports, and shelf. It is a better use of the live information Cartographer already owns.

## What the current code says

The relevant seams are real and already close to the proposed shape.

| Place | Current behaviour | Mismatch |
| --- | --- | --- |
| `src/state.mjs` | `direction()` turns plan state into a short next-action instruction. The block is fresh and lives at the request tail. | A ready move is effectively told to run; there is no preflight over evidence, shelf freshness, atlas pressure, or the local boundary of the task. |
| `src/request.mjs` | A focus starts from the main active messages, is dressed with `dressTask()`, then receives a state block too. | The focus inherits the main conversation and broad planning pressure. It is not a strong attention firewall. |
| `src/context.mjs` | `effectiveShelfFor()` merges the main shelf into every focus shelf. | Useful evidence is inherited wholesale rather than deliberately selected for the task. |
| `src/tools/task.mjs` | `assignedBrief()` copies the stored move action, targets, proof, capabilities, and file-operation budget. It accepts optional free-form `context`. | The action may be feature-sized, and the task has no structured, provenance-bearing handoff of the particular shelf evidence chosen by the main context. |
| `src/plan.mjs` | An envelope owns intent; a move owns exact revision, targets, proof, approval, report, and acceptance. | This is the right authority model. It should not acquire a second nested work-plan. |
| `src/tools/change.mjs` | A new-file write is clipped, but an exact edit can replace an entire file. Authority counts calls and paths, not changed surface. | The physical guard is asymmetric and can be bypassed. |

The shelf already has the intended handoff character: its snapshots survive collapse, carry stable placement IDs, and are available when a task begins. The missing distinction is between **the main shelf as working memory** and **the evidence deliberately handed to this focus**.

## The shape

```text
shared brain and active project
           │
           ▼
main request: full history + fresh state tail
           │
           │  decide: observe, revise, or delegate
           ▼
Dispatch lens: live facts, not a second planner
           │
           │  choose a narrow move, boundary, and evidence
           ▼
focus capsule: move contract + selected shelf snapshots
           │
           │  local work, checkpoint, report
           ▼
main request: fresh state tail again; review, accept, or replan
```

There are three different responsibilities.

1. **Judgment belongs to the main context.** It decides whether a move is sufficiently grounded, whether it needs more reading, what local outcome is next, and which evidence matters.
2. **Memory belongs to the existing brain.** Atlas, ledger, shelf, reports, catalog identities, checkpoints, and plan records remain the only durable sources.
3. **Safety belongs to the authority layer.** Exact targets, approvals, checkpoints, and a future symmetric changed-surface guard stop an execution from exceeding its authority. They do not decide what good delegation means.

The harness derives live facts and projects them into the right context. It does not infer a semantic implementation plan, silently choose a move, or create a new agent.

## 1. The main-only Dispatch lens

The state block remains the trusted tail of every main request. Its current `direction()` paragraph becomes a richer **Dispatch** section, after the project, atlas, ledger, plan, context, and shell facts it relies on.

It is a decision surface, not an autonomous decision engine. It says what the harness can know mechanically and gives the main context a short protocol for using it.

For a ready move, the section should show:

```text
Dispatch
m12 is eligible, not yet a command to start.

Contract
  Targets: src/atlas.mjs, test/unit.mjs.
  Done when: normalized explicit focus persists and is covered.
  Proof: named unit-test result.

Grounding
  src/atlas.mjs: direct-hot; linked node current; sh17 is a current snapshot.
  test/unit.mjs: hot; no shelf snapshot selected.
  Active lens: src/atlas.mjs — persistence work.
  Constraints in view: salient ledger notes remain above.

Before a focus
  I decide whether these facts support one local outcome. If not, I read or inspect first.
  I choose the shelf evidence and state the boundary that narrows this move; neither adds authority.
```

For a reported move, blocked move, absent move, or pending approval, the section keeps the existing priority: review evidence first; inspect and add a narrower successor rather than rerunning blocked broad work; decompose before approval; keep looking while approval waits.

The lens may mechanically derive only facts with clear provenance:

- the current move revision, status, targets, done-when line, proof, capabilities, and approval state;
- atlas focus, active-target overlay, direct/nearby/checking/gap status for a target path;
- matching shelf placement IDs, whether their snapshots are current, changed, stale, absent, or too large to render;
- current checkpoint/report facts for that move; and
- existing salient notes, which remain visible as notes rather than being guessed relevant from a text match.

It must not claim that a move is semantically coherent, that a shelf file is sufficient, or that a ledger note applies to a path. Those are the main context's judgment.

### Main-context prompt contract

The standing prompt needs one concise dispatch rule, backed by the tail:

> A ready move is eligible, not automatically ripe. Before I start a focus, I use the fresh Dispatch facts to decide whether one local outcome is clear, whether the evidence that matters is current, and what the task leaves for later. If not, I read, map, or revise the move first. I hand a focus only selected evidence and a boundary that narrows its stored move; a handoff never expands authority.

The plan prompt should also make the move's role explicit:

> A move names one observable local outcome, not a feature heading. Its action, done-when line, proof, and targets must let me tell whether that outcome is complete. If one task would need to finish several outcomes, I declare several moves before approval.

This uses existing `action`, `doneWhen`, `proof`, and targets rather than adding a public slice schema. The envelope remains the place for the broad feature.

## 2. A real focus capsule

A focus should be a prepared local context, not a full forked copy of the main context with an extra paragraph appended.

Durable storage may still fork the parent conversation. That preserves lineage, replay, report history, and the fact that this is one agent. Request assembly for a focus should instead project a small capsule to the provider.

| Main request | Focus request |
| --- | --- |
| Full active conversation, full current state tail, plan, requests, wake information, broad intent, and the whole main shelf. | Shared standing prompt; optionally the frozen project top for orientation; the focus capsule; selected snapshot evidence; the focus's own calls/results/notes; local operational state and windows. |
| Decides what work comes next. | Carries out one prepared local outcome and returns evidence. |
| May change the plan and accept a report. | Cannot change the plan, start a focus, wake, or sleep. |

A focus does **not** receive the main Dispatch lens, the main Requests queue, broad envelope rationale, or unrelated current plan/ledger/atlas material by default. It can still use the existing read and brain tools if its evidence conflicts or a genuine local question appears. The design is better inputs and less ambient pressure, not removal of agency.

### Capsule contents

The task's first provider request should make its contents plainly visible:

```text
Focus capsule

Purpose
  Persist the normalized explicit-focus record.

Boundary
  Complete persistence and its direct test only.
  Do not derive attention heat, alter graph projection, or change the screen.

Evidence handed on
  sh17 · src/atlas.mjs lines 80–210 · snapshot <digest>.
  sh18 · test/unit.mjs relevant test block · snapshot <digest>.
  n9 · persisted focus remains until visibly replaced or cleared.

Move authority
  m12 revision 3; declared targets; capability and checkpoint contract.
  Done when and required proof as stored in the move.
```

The first three parts are the main context's preparation. The last part is the existing exact authority contract.

The boundary may only narrow a move. It cannot add a target, capability, network grant, proof condition, or completion claim. If the main context cannot state a boundary without leaving the move unfinished, the move was broad and must be revised or split before dispatch.

The task header should say this plainly:

> This is prepared local work. The contract says what I may change; the handoff says why, where to start, and what I leave alone. Capacity is not an instruction to finish adjacent work. When this local outcome is done, I return; when the evidence shows another outcome is needed, I report it for the main context.

The exact budget remains visible because it is real enforcement. Its wording changes from an implied task size to a ceiling:

> The operation count is a stop, not a quota and not a measure of scope.

## 3. Selected shelf handoff

The main context should choose evidence; the harness should preserve that choice exactly.

A focused `task` call gains one non-authorizing handoff input in addition to the existing optional context text. The recommended shape is an optional list of existing **main-shelf placement IDs**, for example `shelf: ["sh17", "sh18"]`.

This is not a setting or a new public tuning control. It is the task's explicit input material, analogous to a person putting two source pages beside a colleague before asking for a local change.

At task start, the harness:

1. resolves each selected main-shelf placement;
2. captures the selected rendered snapshot, source reference, and digest in the task run record;
3. renders those captured snapshots under `Evidence handed on` in the focus capsule; and
4. gives the focus a separate local shelf for material it discovers while working.

The task run record, rather than the mutable main shelf, is the replay source. Re-running after a restart therefore sees the same handoff. The report and Model view can identify the exact inputs without treating a later shelf refresh as though it had been present at dispatch.

No shelf selection means no main-shelf inheritance. The focus may still read the exact target or shelf a new local item, but it does not begin with unrelated main working memory. Existing `handOn: true` and `return.shelf` stay as the reverse handoff from a focus back to the main shelf.

The existing free-form `context` field remains useful for a short boundary and facts that are not a source snapshot. It should be capped and rendered as an explicit `Boundary and facts from the main context` part. It is never parsed for authority or shelf IDs.

## 4. Scope without a second plan

The durable plan stays deliberately small.

```text
envelope  broad user intent and its overall done-when line
move      one approved, observable local outcome
handoff   ephemeral execution interpretation and selected evidence
report    what actually happened, with checkpoints and proof
```

A handoff does not become a card, an approval object, a user-visible queue, or an independent lifecycle. It is attached to one task run and exists because provenance matters.

This keeps exact approval honest:

- The user approves the current move revision, not a future feature invented under it.
- The main context may make a handoff narrower than the approved move without acquiring authority.
- If fresh evidence changes the move's outcome, targets, proof, or capabilities, the main context edits or supersedes the move. That creates a new revision and follows the existing approval rule.
- If an implementation needs several local outcomes, those moves are visible before approval. The main context does not hide a feature-sized program inside the handoff.

The target count and file-operation count remain hard ceilings. They stop being the explanation of why a task is small. A source change plus its directly necessary test can be one local outcome; four paths and one compressed mutation are not automatically one coherent task.

## 5. The physical backstop remains separate

Better dispatch is the primary answer to bad delegation. It is not a proof that every focus will make a small edit.

The current mutation primitive still has a real bypass: `write` clips a new file, then `edit` may replace its entire contents in one direct operation. Shell writes are also checked only at the final checkpoint. No prompt can make those mechanisms truthful scope enforcement.

The physical rule should be simple, symmetric, and subordinate to the orchestration design:

1. **Measure changed surface, not mutation calls.** Before every direct create, edit, or replacement, compute the actual before/after text change. Added and removed lines and bytes both count, so a huge one-line replacement cannot evade a line measure.
2. **Use one fixed focus-local surface allowance.** It is product policy, not a user setting. The focus sees the real allowance and remaining amount in its task state and tool results; it is not hidden magic. `fileOps` remains an anti-loop ceiling only.
3. **Refuse atomically; never clip.** An over-limit create or edit changes nothing. The tool says that the local outcome needs a successor move or a more deliberate construction path. A partial file is not silently made authoritative.
4. **Apply the same rule to new and existing files.** A new file may be complete when it actually fits. A large file begins with a small valid scaffold and grows through explicit, bounded changes. A whole-file `oldText` match does not create an exemption: the actual diff still consumes the allowance.
5. **Do not create a remove-and-recreate escape hatch.** Deleting a file is its own explicit outcome. Recreating the same path in the same focus is not an alternate whole-file rewrite path, and a later create is still surface-limited.
6. **Treat shell writes honestly.** Until writable commands run in a staging/overlay workspace whose diff passes through the same surface check before it reaches the project, shell scope remains checkpoint detection rather than prevention. The prompt and UI must continue to say so. Normal source changes should use the direct file path; a generator/formatter needs the staged path, not an unconfined exception.

This is deliberately not a region-card system. It keeps one measured number per running focus, applies equally to all direct mutation primitives, and makes broad replacement impossible to hide inside an `edit` call. The Dispatch lens makes that guard rare rather than the way the agent discovers what work belongs together.

The exact allowance requires calibration against the existing test corpus and a few real tasks. The design decision is the invariant—measured, visible, atomic, symmetric, focus-local—not a new public knob or an opaque heuristic.

## 6. Source-level implementation shape

After agreement, the work divides cleanly.

| Area | Change |
| --- | --- |
| `src/state.mjs` | Replace the direct ready-move instruction with a main-only Dispatch renderer. It derives target-level atlas/shelf/report facts and keeps the existing review/block/approval priorities. Add a small focus-only operational state projection instead of reusing the main state body. |
| `src/request.mjs` | Split main and focus request projection. Preserve the durable fork but stop replaying the parent planning conversation into a focus provider request. Render the capsule, selected evidence, local task state, windows, and task steps. |
| `src/context.mjs` | Stop wholesale main-shelf inheritance for foci. Store the captured handoff evidence on task state/run data; keep a focus's own shelf and existing hand-on behaviour. |
| `src/tools/task.mjs` | Accept selected shelf placement IDs as evidence, capture them durably with the run, construct the capsule, and make replay use the captured selection. Keep `context` as plain narrowing facts, never authority. |
| `src/prompt.mjs` | Add the main dispatch practice, revise plan/task wording around local outcomes and ceilings, and make `TASK_HEADER` describe prepared local work. Every new sentence must match implemented behaviour. |
| `src/plan.mjs` and plan UI | Keep the envelope/move model and approval lifecycle. Do not add card queues, span records, or public scope controls. Improve move wording/display only if needed to make the local outcome visible. |
| `src/tools/change.mjs` | In the safety phase, replace clipping and call-count-only scope with atomic, symmetric changed-surface accounting. Keep exact target and live-move checks. |
| writable shell path | Design the overlay/staging route separately, then make it feed the same changed-surface gate. Do not call final checkpoint detection preventative confinement. |
| Model/screen views | Show a focus capsule and its selected evidence as generated request parts, so the user can inspect what the focus actually received. Do not make the Dispatch lens a mutable brain record. |

No new top-level `book file read`, no `book target=shelf`, no shelf-question ceremony, no user-facing tuning control, and no substitute provenance mechanism are introduced.

## 7. Verification plan

The offline suite should prove the mechanics, not claim a model's judgment improved.

### Request and capsule tests

- A main request contains the Dispatch section at the tail; a focus request does not.
- A focus request excludes parent planning history, Requests, broad plan queue, and main Dispatch text while retaining the durable fork for provenance.
- A focus receives the exact stored move revision, selected shelf snapshots, source IDs/digests, boundary text, and local task operational state.
- A task replay after restart receives the same captured handoff even if the main shelf has since changed.
- Unknown or non-main shelf selections refuse clearly and cannot add authority; a stale selected snapshot is visibly labelled rather than passed off as current.
- A focus can hand newly discovered material back through the existing `handOn`/`return.shelf` path.

### Authority tests

- A handoff cannot add targets, files, commands, network, proof, or approval.
- Editing a move after evidence changes still withdraws approval as it does now.
- A task with a narrow handoff but an unfinished broad move cannot report that broader move complete.
- A reported move still needs checkpoint evidence and main-context acceptance.

### Mutation tests

- A create over the changed-surface allowance leaves no partial file.
- A large `edit` and a large `write` fail by the same accounting rule.
- Replacing an entire created file cannot bypass the create rule through one `edit`.
- Remove-and-recreate cannot bypass it in one focus.
- The exact-target and checkpoint tests continue to pass.
- The shell exception is either visibly still detection-only or routed through the staged gate; no test describes it as more than it is.

### Observation after offline proof

A deliberate live session can inspect the actual main and focus provider payloads, the Dispatch tail, the capsule, and the resulting report on a throwaway project. That is observation, not a general pass/fail claim, until the measurement decision in `docs/design.md` is settled.

The full suite remains under its ten-second wall-clock budget.

## What this proposal does not do

- It does not turn Cartographer into a manager of independent workers.
- It does not add a hidden model that decides semantic scope.
- It does not create a second durable hierarchy beneath a move.
- It does not let a handoff expand approval or authority.
- It does not replace the atlas, ledger, shelf, reports, or plan with a new task database.
- It does not claim prompts alone enforce changed surface.
- It does not change the user-visible approval, checkpoint, undo, catalog, or top-level read/shelf contracts.

## Recommended decision

Adopt this direction before changing implementation:

1. State tail as a **main-only Dispatch lens**.
2. A task as a **focus capsule**, not a replay of the main planning environment.
3. Explicit, selected shelf snapshots as the evidence handoff.
4. Existing envelope/move authority with no card graph or public scope knobs.
5. A later but non-optional symmetric changed-surface backstop, including an honest staged answer for writable shell commands.

That restores the intended relationship: the well-informed main context chooses a good delegation from the live atlas, ledger, plan, and shelf; the focused context receives the useful part of that understanding and can do its work without being pushed to finish the whole feature.
