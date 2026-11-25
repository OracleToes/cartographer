# Focused tasks: discussion notes

**Status: discussion, not a specification or an implementation plan.** This
records the direction being explored and questions still to settle. `SPEC.md`
remains the current specification; nothing here changes it or authorizes an
implementation. “Focus” and “task” are working names, not a choice of name.

## Decisions since these initial notes

The discussion below records the earlier exploration; where it calls these
points open, the following later decisions take precedence:

- Keep the existing direct behavior and add orchestration as a separate mode.
  One model works at a time; the main agent is an orchestrator and bookkeeper.
- The focused task may directly update shared Atlas and Ledger; main Carto
  remains responsible for the overall map and reconciles it before more work.
- Main Carto may optionally include any context entry in a task call, including
  ephemera, Chat, Ledger and relevant files; task selection need not modify main
  persistent pins.
- Every return causes a full **main** collapse, with its normal pin refresh,
  sweep, pending marks and archive grace. The person explicitly accepts that
  rapid task returns can expire unpinned archive items at the next collapse.
  Brain entries and Chat survive unless marked; unpinned main ephemera do not.
- At the warning, give the task a turn to write Atlas/Ledger, then force its
  report. On overflow, tell main Carto via a system message to investigate how
  much was done and where continuation belongs. Do not claim a report exists.
- The person retains normal controls, can access the archive while the task
  runs, and sees a clear task indicator and a task view. Task pins and
  person-triggered task collapses are local to that task. A separate task
  session store is the person's proposed direction.
- Task Chat is not preserved on return. The required return chat message is
  recorded permanently in **main** Chat, subject to normal manual pruning.
  What happens to task Chat during its own local collapse still needs definition.

A proposed implementation plan is in `docs/orchestration-plan.md`. It separates
these decisions from remaining questions and technical feasibility checks.

## The direction being explored

Carto would work as a main agent and one temporary, focused worker, **not as
parallel agents**. The person's hardware can run only one model at a time.
The main agent and worker could be the same model with different contexts;
using a different model would add model-unload/reload costs. Either way, only
one works at a time.

The person is considering a fundamental shift in responsibilities:

- The main agent would have a limited set of basic tools, including Atlas,
  Ledger, read, and chat. It would plan and maintain the project's working
  understanding and progress.
- More of the actual work would happen in a focused task with its own tools.
  Exactly which tools belong to each context is still to be discussed; the
  distinction is not yet a completed tool matrix.
- A task has a specific instruction and **done-when** criteria. Carto prepares
  its context deliberately: the instruction to itself, relevant context, and
  pinned files. The whole working context switches to that prepared task.
- The focused worker works until its done-when is satisfied or its context
  reaches the existing warning threshold, whichever comes first. If it reaches
  the warning first, it must return a report at that point, with GBNF
  enforcement. The return includes a required chat message; what is recorded
  as Chat and who receives the report still need discussion.
- On return, Carto sees the report and the effects on the project and Brain,
  including Atlas and tree/staleness information. Its context is rebuilt so
  the relevant state, including pins, Atlas, and Ledger, is current. It then
  maintains Atlas and Ledger before delegating more work.

The proposed flow is roughly:

```text
person's request
  → main agent maps the work in Atlas and tracks progress in Ledger
  → prepare a focused task: instruction, done-when, selected context and pins
  → switch context; one focused worker acts
  → report on completion or at the context warning
  → rebuild main context from current state and return the report
  → main agent reviews changes and updates Atlas and Ledger
  → next task, or a response to the person
```

The Atlas plan is a loose graph: branches, leaves, clusters, or whatever shape
fits the work. The active progress belongs in Ledger. This builds on the
existing Atlas/active-leaf idea, while making the task handoff the place where
work receives a specific working context.

### Concrete illustration, not a prescribed workflow

Asked to change a UI feature, Carto might map the goal into connected Atlas
nodes, put the active leaf in Ledger, and prepare a task to change one part of
the feature. It would include the relevant file context and a done-when such as
“the selected item can be copied and the relevant behavior is verified.” The
worker edits and checks what it can. It returns what it changed, what it
verified, and what remains uncertain—whether it finished or had to stop early.
Carto then sees the updated project and Brain, reconciles the plan and progress,
and decides what to do next. The exact report contents are a proposal for
conversation, not a required schema.

## Relationship to the current spec

This idea uses several existing concepts, but it is **not** implemented by
merely relabeling them:

- **Atlas and Ledger** already hold a loose goal/step graph and live progress
  (§2.1–2.2). The new idea puts the main agent's upkeep and delegation around
  that graph at the center of the working loop.
- **One context and one tool set today.** The current spec describes one
  agent with the tools in §7, a frozen prefill, and a live context around one
  persistent Brain. It does not specify a separate focused-worker context,
  handoff, or return. Pi Durable supplies conversation and task primitives;
  that does not by itself establish Carto's semantics for this feature (§12).
- **Return-time rebuild is a real design change.** The head is frozen between
  collapses (§5.6); rebuilding from current Atlas, Ledger, and pinned files
  when a task returns would require a specified transition. A normal collapse
  also applies pending marks, sweeps ephemeral material, and advances archive
  grace (§3–4). Whether a task return does those things is not decided. The
  spec also describes apply-now rebuilds (§4.1), but neither existing action
  should be assumed to be the new handoff without examining its consequences.
- **Staleness is useful but not a complete change report.** The state block
  reports stale Atlas attachments and pinned reads/files (§5.3, §5.5); the
  Tree view can show filesystem and Git information. These are not a complete
  task-specific diff or proof that an Atlas note is current. The tree in the
  state block is paged and its scan is bounded (§6.3). How the main agent learns
  precisely what the task changed is still open.
- **The threshold is a warning today.** `[COLLAPSE NEEDED]` is based on an
  estimate at the configured percentage, default 75%, of a *known* context
  window (§4, §5.3). Today it asks the agent to prepare and collapse; it is
  not a forced task-return boundary. A task that jumps past the threshold in a
  large turn, or whose window is unknown, needs explicit consideration.
- **GBNF enforcement would be new behavior.** The current spec favors a trusted
  prompt and does not specify a native-grammar gate for this return (§1, §7).
  This is the person's proposed exception for reporting at the warning, not
  evidence that every model route currently supports it. A grammar can constrain
  a response's shape, but cannot prove that its claims or done-when are true,
  and cannot itself produce a report after a crash or an exhausted context.
- **Chat has a specific meaning.** Only deliberate `chat` records and the
  required collapse message address the person (§2.3); plain model text is not
  Chat. A required task-return message needs to fit that distinction without
  accidentally duplicating it in the rebuilt context.
- **Scope is not a sandbox.** Read-only and path settings constrain certain
  tools, while `bash` remains trusted (§6–7). A focused assignment or a smaller
  tool set should not be described as secure confinement without additional
  enforcement, which has not been decided.

## Questions to work through

1. **Shared Brain and pins.** Can the worker directly update Atlas, Ledger and
   pins while it works, or does it report proposed updates for the main agent
   to make? Are the pins selected for a task temporary task context, shared
   persistent pins, or both? Person-owned pins must not be silently removed.
2. **Tool split and task scope.** Which capabilities does the main agent retain,
   and which are exclusive to the worker? Can the main agent make a small change
   directly, or is every project change a focused task? How does the person
   choose the task's context without accidentally losing needed information?
3. **Report and Chat.** Is the required chat message a person-facing Chat
   record made by the worker, a message handed to the main agent to deliver, or
   part of the return in some other form? What must distinguish completed,
   partial, blocked, and unverified work?
4. **Return and rebuild.** How is the suspended main context restored and
   refreshed without losing the person's messages, duplicating Chat, or
   silently applying marks and archive expiry? What parts of the old main body
   remain? What happens to the worker's unpinned context?
5. **Threshold and failures.** How is a report requested at the warning while
   leaving enough space for it? What happens with an unknown window, an
   overflow before the warning, unsupported or failed grammar enforcement, a
   stop, or a crash? Any partial file/Brain changes may already exist; an
   interrupted task must not be represented as a completed one.
6. **Visibility and control.** What does the person see while the worker is
   active, where do messages and steering go, and how do pause, interrupt and
   cancel behave across the handoff?

These are questions for the discussion, not defaults or decisions. The first
question is particularly consequential: shared Brain writes versus a report-only
worker changes what the rebuild must reconcile.
