# AGENTS.md

This file tells an agent how to work in this repository. It is written for the
agent, not for the person: **you must read this file at the start of every single turn**,
before reading other files or touching any code, and follow it over any habit you
brought with you.

The person is `OracleToes`. They own this project. When their word and this file
disagree, their word wins and this file is wrong until it is fixed.

## 1. Authority

From highest to lowest:

1. **The person, in conversation.** A statement in a conversation outranks every
   document here, including this one. If a document contradicts them, the
   document is stale and the contradiction is a task.
2. **`MINI.md`.** The specification of record: what Carto is, what it keeps, and
   what it must do. The file name is fixed for compatibility and is not renamed.
3. **`docs/intent.md`.** Confirmed intent only. See §6.
4. **This file.** Process: how to work, how to test, what to record, and how to
   report.
5. **Other `docs/`.** Plans and notes. A plan is a proposal, never authority. A
   plan that has been overtaken is marked superseded, not silently edited.

Nothing in a plan, a commit message, or a chat log outranks the person.

## 2. Links and dependencies

The project is built on these packages. They are dependencies, not suggestions.

| Source | Given by | Why it is here | In use |
| --- | --- | --- | --- |
| [pi — `packages/tui`](https://github.com/earendil-works/pi/tree/main/packages/tui) | person | Terminal rendering, layout, focus, editors, scrolling, overlays, key parsing | `@earendil-works/pi-tui` 1.5.2 |
| [pi — `packages/durable`](https://github.com/earendil-works/pi/tree/main/packages/durable) | person | Durable conversations, tasks, tool calls, sleeps, wakes, retries, SQLite storage | `@earendil-works/pi-durable` 1.5.2 |
| [pi — `packages/ai`](https://github.com/earendil-works/pi/tree/main/packages/ai) | person | Models, providers, tool validation, streams, usage, provider errors | `@earendil-works/pi-ai` 1.5.2 |
| [pi — `packages/chord`](https://github.com/earendil-works/pi/tree/main/packages/chord) | agent | pi-durable's own substrate — documents, store, SQLite facade (`sqlite/node`) the Brain store is built on | `@earendil-works/chord` 1.5.2 |
| [pi — `packages/schema`](https://github.com/earendil-works/pi/tree/main/packages/schema) | agent | Tool parameter validation for the product tools (`defineTool` arguments) | `@earendil-works/pi-schema` 1.5.2 |
| [darrenburns/posting](https://github.com/darrenburns/posting) | person | Inspiration for the terminal layout only: keybinding bar, action registry, overlays. Not a dependency and not a port target | reference only |

The three `pi` links are the reason this project exists in its current shape.
They were given when the project started, and the agent did not record them at
the time; that omission is what allowed a hand-built terminal layer to grow
beside working libraries. 
Rules:

- **A link the person gives is recorded here in the same turn it is received.**
  If you cannot record it, say so in the same reply. A link that exists only in
  a chat log is a link that will be lost, and has been lost before.
- **The `Given by` column is factual.** `person` means they supplied it.
  `agent` means you found it. Never promote a source you found into one they
  gave you; that puts your voice in their mouth.
- **Before you write behaviour, look for it in `node_modules/@earendil-works`.**
  If a dependency provides it, use it. If one nearly provides it, say which and
  why it does not fit. Building behaviour a dependency already supplies is the
  defect this section exists to prevent, and it has already happened here.

## 3. Glossary

Words the person has defined. Use the meaning, not the common one. A word enters
this section only after they define it and confirm the entry.

**INTENT** — what the person wants to be true. It is intent only after they
state it and agree with your restatement of it. Your inference is a draft and
is yours, never theirs. A quote log is not intent.

**DISCUSSION / CONVERSATION** — dialogue between the person and you: back and
forth, dyadic. It is not a question with options attached, not a monologue, and
not several paragraphs of your reasoning presented as agreement. If a
definition has not been talked through, it is not agreed, however carefully you
wrote it.

**CONFIRMED** — the person assented explicitly to the thing you named, and you
are confident they understood both the question and the decision they made.
Choosing an option counts: a choice means your description of it was good
enough. If they are silent about it once, ask again. If they ignore it twice,
drop it: proceed with your recommendation if the work needs it, say that you
did, and never raise it again.

**VAGUE** — a word the person accepts as under-specified. When they use one, ask
what it means *in the context of the problem at hand*, and do not substitute
your own bar. They named `usable` as an example.

**QUESTION** — a request for information, nothing else. A question is never a
request to create, change, fix, or build anything. If the person asks why you
are doing something a certain way, they expect an answer — not work done on the
assumption they wanted it fixed.

**ASSUMPTION** — something the person asserts that might be wrong. If it is
wrong, verify it against the code, the documents, or the dependencies, and tell
them plainly; that is how they learn. Verifying is not permission to change
anything — a wrong assumption of theirs still only earns an answer.

**STATEMENT** — something said so it is in the shared context. A statement
asks for no change, no action, and no acknowledgement. The person does not
need to say "and don't do anything about it."

**REQUEST / TASK** — what is left over once the other three are excluded. It
is asking for work to be done. If the person says it, do the work, or ask
for a decision per §8 — never act on a question, an assumption, or a
statement as if it were a request.

**SENSIBLE** — proportional. Grow the glossary when a correction or a real
question produces a term, not in batches and not for completeness.

**EXPECT** — be confident enough to call the work done before you build it.
Make the edits you expect the stage needs, then, at the end of the stage,
build, then push, then test. Do not build to find out what to do next; that is
not an expectation, it is a probe.

**STAGE / SLICE** — one unit of work that ends in a push. Same thing, either
name. See §4.

**BUILD** — `npm run build`, invoked only as the build step inside `npm test`. A
build is not a test; a build never runs on its own, mid-stage or otherwise.

**PROBE** — a throwaway check for something you were not sure worked. It is not
kept, and it is not a substitute for a test. See §5.

## 4. How to work

- **Read `AGENTS.md` first at the start of every single turn.**
- `git fetch` and check whether `origin` has moved ahead.
- If the workspace has reset, your local commits may be gone while `origin`
  still holds them. Replay your work onto `origin`, push, and say in the same
  reply that you did it.

A **stage** is one complete unit of work that ends when you are ready to tell the
person it is done. While the stage is in progress — reading, deciding, editing — run
nothing: **no `npm run build`, no `npx tsc --noEmit`, no `npm test`, no one-off test,
no probe.** Tests and builds are not sanity checks, not iterative aids, not ways to
help you write code. The build is only ever the first step inside `npm test`; it is
never run on its own. The build and the tests happen strictly once, at the very end
of the stage, right before you stop to tell the person the work is done.

Pushes are not only at the end. Commit and push as you go mid-stage if needed — a
push mid-stage is how work survives a workspace reset, and it implies no verification:
no build, no tests, no gate. The submission sequence, when you have finished all edits
and are ready to report done, is fixed:

1. **Make every edit you expect the stage to need.** Read the code first.
   Make surgical edits to existing files; never overwrite or rewrite entire
   files without the person's express permission.
2. **Run `npm test` — the only command the stage holds.** It builds the project,
   then runs the whole suite. That run must finish in **10 seconds, in total**.
   The suite aborts at 10 seconds and tells you it is taking too long — a suite
   that exceeds 10 seconds is a failure, not a pass, and the fix is to improve
   the slow test or drop the worst offender, then re-run — never to shorten
   the budget, never to run a partial suite, never to add a per-test exemption.
   One-off tests and probes are forbidden at any point before this run.
3. **Commit and push.** Once the suite is green.
4. **Report.** The build happens inside `npm test`, so a green `npm test` is both
   the gate and the proof. Never report done on an unverified tree.
5. **If a test fails or the suite overruns the budget, fix it, re-run `npm test`,
   and repeat.** Never report done on a failing or unmeasured run.

Never run the build, `tsc`, a test, a one-off test, or a probe in the middle of a
stage, or as a check on your progress while working. Reading the code is how you
know what will work; the build and tests, run together inside `npm test` at the
very end, are how you prove it. Never end a turn with an unpushed commit or a
dirty tree.

**Keep the branch pushed and current.** This workspace resets to base without
warning, and the person cannot see anything that is not pushed. A push
mid-stage is expected and claims nothing; only the end-of-stage sequence
submits. Before you touch a file:

## 5. Tests

Tests exist to catch breaks. They are not evidence of intent and not a
substitute for reading the code.

- **The only test command is `npm test`.** It builds the project and runs the
  whole suite. It runs once, at the end of the stage, after every edit is made.
  One-off tests, partial runs, and probes are forbidden mid-turn, mid-stage, and
  mid-slice. The agent never runs `node --test`, `npm run build`, `tsc`, or any
  other build/test command by hand.
- **The suite must finish in 10 seconds, in total.** Not per test: the whole
  run. A suite that exceeds 10 seconds is aborted by the guard and reported as
  taking too long — that is a failure, not a pass. The fix is to improve the
  slow test or drop the worst offender, then re-run `npm test` with the change
  in place. Never shorten the budget, never add a per-test exemption, never
  raise the budget because a test overshot it.
- Remove what does not earn its cost: obsolete cases, implementation mirroring,
  duplicate coverage, unused fixtures. Deleting is a deliverable, not a loss.
  See `docs/tests.md` for the full policy.
- Do not chase a number. Do not add tests to keep a count up. Do not delete the
  only guard for a real break to make a failure disappear.
- **A probe is allowed** when you genuinely need to check something before
  you rely on it. Run probes only at the end of the stage, after the push, and
  never keep them. A probe is not a test and cannot be used to dodge the budget.
  A probe is not permitted mid-turn, mid-stage, or mid-slice.


## 9. Do not

- Do not overwrite entire files without the person's express permission. Make surgical edits to specific sections; whole-file replacement risks wiping existing functionality, comments, and structure.
- Do not run the build, `tsc`, the suite, a one-off test, a probe, or any checkwhile a stage is in progress — mid-turn, mid-stage, mid-slice. The only testcommand in the workflow is `npm test` run once at the end of the stage.
- Do not use a probe to replace a test, or a test to replace reading the code.
- Do not build what `@earendil-works/pi-tui`, `pi-durable`, or `pi-ai` already
  provide.
- Do not end a turn with work that is not pushed.
  tested without having seen the test pass.
- Do not be sycophantic. No performed agreement, no unearned praise, no
  softening the truth so it lands easier. Say what you actually think, and if
  the person is wrong, say so plainly and say what is true instead.

## 10. The Arena workspace resets

Something in this environment intermittently resets the repository between
turns: the working tree is left intact, but `node_modules`/`dist` vanish, and
on one occasion the local branch pointer `arena/<branch>` was moved back to
the base commit while the working tree kept everything as untracked files.
The remote tip is the source of truth. Expect it, and repair it when found:

- Treat the local branch as possibly stale. At the START of every turn —
  before any edit, build, or test, not only when git misbehaves:
  - **Read `AGENTS.md` first.** This is mandatory on every single turn.
  - `git fetch origin <current-branch>`; compare `git rev-parse HEAD` with
    `origin/<branch>`. A commit onto a swept pointer lands as a stray commit
    on the base; it happened once and cost one misplaced commit.
  - **Tell the person when the session has compacted — once, not every
    turn.** If this turn starts with a compacted session summary in front
    of you — a fresh session-memory/compacted-context block in this turn's
    arena-system-message, or the user reports a compaction — tell the
    person in the first reply, exactly once: one line on what the summary
    says, what the repo state actually holds, and what is left. Do not
    re-tell the compaction on every turn after it has happened. If nothing
    in this turn shows a compaction, say nothing — a disclosure on every
    turn masks the one that matters.
- If the branch pointer trails the remote tip, move it forward with
  `git reset --mixed origin/<current-branch>` (working tree untouched; the
  reflog keeps the old value). Never force-push; never pull rewrites onto a
  tree you have not checked.
- If `node_modules`/`dist` are missing, `npm ci`. The build is not run before the
  stage submits — it is the build step inside `npm test`.
- The person owns pulls: do not fetch-and-merge to "get ahead"; the fetches
  in the two points above are for staleness detection and pointer repair, not
  for changing content.
- Report every repair in one line at the end of the turn — what was reset,
  what was restored, what is now true.
- If a repair fails or the tree contains something neither side explains,
  stop and ask; do not improvise a recovery.
