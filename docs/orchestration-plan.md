# Orchestration mode: proposed plan

**Status: earlier proposed plan, not implementation or a change to `SPEC.md`.**
The proposed [regenerative orchestration revision](regenerative-orchestration-plan.md)
supersedes this plan's proposed approach for discussion, not the person's recorded
decisions. Those decisions are carried into the revision; unresolved choices
remain unresolved until the person decides. This original is retained for context.
No parallel models or concurrent agents: this is a sequential context switch on
hardware that can run only one model at a time.

## Intended behavior

Keep existing Carto as a direct mode, with its current tools, context, controls,
and collapse behavior. Add an independently selectable orchestration mode:

1. Main Carto uses its limited basic tools (including Atlas, Ledger, read and
   chat) to understand and plan the work as a loose Atlas graph, track active
   progress in Ledger, and form a focused instruction with explicit done-when.
2. A task call can optionally select **any** relevant context entries, including
   ephemera, Chat, Ledger, Atlas and pinned files. The task gets its own context
   and work tools; selection for the task does not require changing main pins.
   The main context is suspended while the one focused task runs.
3. The task may update the shared Atlas and Ledger directly. The main agent
   remains responsible for the overall map and reconciles it before delegating
   again. The task's project changes and Brain updates are real, not a sandbox
   or a speculative branch.
4. When done-when is met, the task returns a report and a required message for
   main Chat. At the existing context warning, if not done, it gets a turn to
   make Atlas/Ledger entries, followed by a forced report. GBNF was requested
   for enforcement; feasibility and failure handling are a gate below.
5. Every task return performs a **full main collapse**, including normal sweep,
   pending marks, pin refresh and archive grace, then resumes main Carto with
   the report and the current Brain. The required return message becomes one
   main Chat record; task-local conversation is not preserved on return. Main
   Carto reviews the result and updates Atlas/Ledger before further delegation.
6. If the task overflows, do not pretend a report exists: send a system message
   to main Carto telling it to investigate what was done and where to stitch a
   continuation into the project. Partial project and Brain changes remain.

The person can see clearly that a task is active, use a task-specific UI view,
use normal controls and access the archive while it works. Task pins and a
person-triggered task collapse are local to the task. A separate task session
store is the proposed direction. Main Chat is retained except when manually
marked/pruned; main unpinned tool calls and other ephemera are swept on return.

The usual archive rule is intentional: unpinned material archived at one
collapse expires at the next, even if returns occur in quick succession. Tree
and stale markers are useful signals, **not** a complete list of task changes.
The report must not imply verification or completion that did not happen.

## Design before implementation

Resolve these details with the person rather than treating the proposals as
confirmed decisions:

- **Mode lifecycle:** default for existing/new projects, how to select and switch
  modes, persistence and whether switching is allowed during a task. It must be
  distinct from the existing edit/read-only and path-scope settings, which still
  apply. Recommend keeping current behavior as the default for existing projects.
- **Task input and visibility:** define addressable eligible entry types and
  snapshots versus live references, how missing/stale entries are reported, and
  which shared Brain information is automatically visible versus selected. Avoid
  silently copying all main Chat or all main pins into the task. Explicitly
  define the task's access to shared Atlas/Ledger despite a focused prefill.
- **Reports:** define a minimal report contract distinguishing done, partial,
  blocked and unverified work, what changed, and what remains; specify whether
  the Chat message is separate from or part of the report. The user's required
  main Chat message is distinct from task-local Chat. Preserve each exactly once
  in its intended destination and never invent a successful report on failure.
- **Local collapse and archive:** task Chat does not survive *return*, but its
  behavior across a task-local collapse is not yet specified. Clarify how a
  local collapse interacts with shared Brain marks, a shared archive and archive
  grace; local pins/collapse must not mutate main pins or collapse the main
  context. In particular, do not accidentally expire main archive material on a
  task-local collapse without a decision. Person access to the archive remains.
- **Interaction:** specify message routing when a task is active, pause/resume,
  interruption versus cancellation, pending messages, and task-view navigation.
  Define what happens on user interruption and local collapse at the warning,
  and when mode changes, application exit or wipe are requested mid-task.
- **Tools and jobs:** define an exact tool matrix, including main read/tree,
  task work tools, Brain writes, chat, pin, collapse, shell and persistent
  jobs. Preserve read-only/path-scope semantics; these are not a sandbox and
  shell has existing limitations. Decide task ownership and survival of jobs;
  do not inadvertently kill or leak them across task return.
- **Threshold edge cases:** unknown windows, a large tool result crossing the
  threshold, lack of output space, bookkeeping consuming remaining space,
  provider errors, crash and unsupported grammar. Set a bounded policy; if a
  report cannot be generated, disclose failure and preserve partial work.

## Technical feasibility gate: required report

Inspect the installed pi-durable and pi-ai APIs and the actual llama-swap /
llama.cpp route before selecting an enforcement mechanism. The installed
`pi-ai` types expose tool constrained sampling using JSON Schema or OpenAI
Lark/regex grammar variants; that alone does **not** establish native GBNF
support or a way to force the next response/tool call through this route. Verify
how the route supplies and enforces grammar and how a forced report interacts
with durable replay. If the requested GBNF cannot be enforced, surface that
limitation and agree a solution before claiming the feature meets the design;
never silently downgrade to prompt-only enforcement. A grammar constrains form,
not truth, and cannot guarantee a report after overflow or a crash.

## Proposed stages

Each implementation stage should be a coherent, reviewed change, with the
whole `npm test` suite passing within the repository's ten-second budget before
commit and push. The stages do not authorize implementation by themselves.

### 1. Specify the mode and its boundaries

Resolve the decisions above and update `SPEC.md`: mode selection; handoff;
context selection; shared versus local state; user controls; reports; normal
and failed return; local and main collapse; archive and recovery. Define a
single active task and an explicit serialization point so no second inference
runs during handoff. Review existing `src/runtime/live-session.ts`,
`carto-extension.ts`, `collapse.ts`, `brain-store.ts`, `config.ts` and
`src/domain/projection.ts` against the revised spec before choosing storage and
APIs. Verify pi-durable conversation/task/recovery capabilities rather than
building substitutes for what it provides.

### 2. Durable handoff and isolated task context

Introduce the mode and task-call boundary with explicit instruction, done-when
and optional selected context; validate references and build a task-specific
prefill. Use a separate durable conversation/store if supported and appropriate,
with task-local pins and Chat, shared project and Atlas/Ledger, and no accidental
main Chat writes from task conversation. Define a durable state machine for
prepared, running, reporting, returning and finished/failed; retain enough
identity and progress to recover at each boundary without replaying external
side effects or duplicating Chat. Do not rely on store separation alone to
serialize inference. Carry existing direct mode unchanged. Test selection of
individual entries, isolation, shared writes, one-model-at-a-time operation and
restart at handoff boundaries.

### 3. Warning, report and failure path

Implement the warning-time bookkeeping turn and subsequent constrained report
only after the feasibility gate. Specify bounded report/output headroom without
representing the estimated warning as a hard guarantee. Handle ordinary done,
warning, blocked task, overflow, interrupted request and provider/grammar
failure as distinct outcomes. Persist report or failure before main return so a
restart cannot convert incomplete work into success. On overflow deliver the
specified system message and preserve the project and Brain for investigation.
Tests should cover early overflow, unknown window, crossing the threshold in a
large step, report enforcement failure and interruption—not just the happy path.

### 4. Return, collapse and recovery

Integrate with the existing collapse journal/transaction and generation swap;
do not invent a second, weaker collapse. Design durable phases for report/Chat
recording, main collapse, resumption and task-store cleanup so a crash at each
boundary recovers without duplicate Chat, duplicate collapse/expiry, lost
pending person messages, or deleting the only recoverable task state. Main
collapse refreshes pins and applies marks and archive grace as usual. Task-local
Chat is not copied into main; the required return Chat is recorded once, while
failure is explicitly labeled. Test queued messages, pinned main ephemera and
files, marks and two rapid returns with archive expiry, stale attachments,
cleanup/restart and a collapse failure. Preserve existing collapse recovery.

### 5. Person-facing controls and completion

Extend `src/ui/app.ts`, relevant views/commands and `src/runtime/headless.ts`
to display the active task, its local context/chat and status, route controls
and messages according to the agreed semantics, and keep shared archive access.
Use existing pi-tui components. Cover mode selection, direct-mode regression,
task visibility, local pins and collapse, archive operations, stop/pause,
message routing and headless behavior. Exercise an end-to-end task: main plans,
selects context, task updates shared Brain and returns, main collapses and sees
one return Chat plus the report. Also exercise overflow and recovery with no
fabricated report. Keep test coverage focused and the complete suite under ten
seconds.

## Completion criteria

- Existing direct Carto remains usable, with existing behavior and controls.
- In orchestration mode a single focused task uses intentionally selected
  context, work tools, shared Atlas/Ledger and task-local controls, without
  parallel model execution.
- Done and warning returns deliver their required report/message; overflow and
  other failures are honestly represented. Grammar enforcement is verified for
  the actual route, not assumed.
- Main return performs a real normal collapse and resumes from current state;
  Chat isolation, exactly-once delivery, archive expiry, and restart recovery
  behave as specified. The person can see and control the active task and
  access the archive.
- `SPEC.md` and tests describe and verify the delivered behavior, including the
  boundaries where task-local and shared state interact.
