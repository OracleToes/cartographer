# AGENTS.md

This file tells an agent how to work in this repository. It is written for the
agent, not for the person: read it before touching a file, and follow it over any
habit you brought with you.

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
| [darrenburns/terma](https://github.com/darrenburns/terma) | agent | The agent read this while looking at `posting`. The person has never named it, and it is not a dependency | reference only |

The three `pi` links are the reason this project exists in its current shape.
They were given when the project started, and the agent did not record them at
the time; that omission is what allowed a hand-built terminal layer to grow
beside working libraries. `terma` shows the other failure: a source the agent
found, never supplied by the person, that came close to being cited as theirs.

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

**BUILD** — `npm run build` plus `npx tsc --noEmit` exiting zero. A build is not
a test.

**PROBE** — a throwaway check for something you were not sure worked. It is not
kept, and it is not a substitute for a test. See §5.

## 4. How to work

A **stage** is one unit of work, ending in a submission push. While the
stage is in progress — reading, deciding, editing — run nothing: **no
`npm run build`, no `npx tsc --noEmit`, no `npm test`, no probe.** The build
and the tests happen once, at the very end, when you are ready to submit the
code. They are the submission, not a way to check your work as you go. If you
do not know whether something will compile, read the code; do not ask the
compiler.

Pushes are not only at the end. Commit and push as you go, half-finished if
that is where you are — a push mid-stage is how work survives a workspace
reset, and it implies no verification of any kind: no build, no tests, no
gate. The submission sequence, when the work is ready, is fixed:

1. **Make every edit you expect the stage to need.** Read the code first.
   Make surgical edits to existing files; never overwrite or rewrite entire
   files without the person's express permission.
2. **Build.** `npm run build` and `npx tsc --noEmit` must both exit zero. The
   build is the gate: it is what lets you say you are confident.
3. **Commit and push.** Before you run a single test.
4. **Run the tests.** `npm test`, run-only budget: 10 seconds.
5. **If a test fails, fix it, build, push again, then test again.**

Never run tests — and never run a build — in the middle of a stage, or before
the work is ready to submit. Reading the code is how you know what will work;
the build and tests are how you prove it at the end. Never end a turn with an
unpushed commit or a dirty tree.

**Keep the branch pushed and current.** This workspace resets to base without
warning, and the person cannot see anything that is not pushed. A push
mid-stage is expected and claims nothing; only the end-of-stage sequence
submits. Before you touch a file:

- `git fetch` and check whether `origin` has moved ahead.
- If the workspace has reset, your local commits may be gone while `origin`
  still holds them. Replay your work onto `origin`, push, and say in the same
  reply that you did it.

The person does not use git. Do not ask them which commit `base` is; there is no
answer they can give. The reliable solution is the rule above: fetch, keep `HEAD`
and `origin` together, and push small and often so a reset costs nothing.

**If the files and the documents disagree — smell it, do not fix it.** Reading
the specification, the documents, and the code as source of truth, you will
find things that do not sit right: stale rules, silent contradictions, wrong
names, machinery that belongs to a dead era. The pattern to follow:

- Do not edit a source-of-truth document to match what you found.
- Do not silently "fix" the code against it, either.
- Note it, one line each: what it is, where it is, why it smells.
- Bring the list to the person at the end of the stage, in the reply — never
  drip them out mid-stage, and never smuggle a fix in behind them.

The source of truth is theirs to change. Finding a smell authorizes a note,
not an edit.

## 5. Tests

Tests exist to catch breaks. They are not evidence of intent and not a
substitute for reading the code.

- The only test command is `npm test`. It runs at the very end of the stage,
  after the submission push, and only once the work is ready to submit —
  not mid-stage, not as a check on progress.
- **The test run must finish in 10 seconds.** Not the build, not the whole
  command: the run.
- A test that needs longer must earn it, in a comment on that test, saying what
  real boundary it crosses. If a test cannot fit and cannot be made to fit, drop
  it and record what guard is gone.
- Remove what does not earn its cost: obsolete cases, implementation mirroring,
  duplicate coverage, unused fixtures. Deleting is a deliverable, not a loss.
  See `docs/tests.md` for the full policy.
- Do not chase a number. Do not add tests to keep a count up. Do not delete the
  only guard for a real break to make a failure disappear.
- **A probe is allowed** when you genuinely need to check that something works
  before you rely on it. Run probes at the end of the stage, after the push,
  not in the middle of it, and do not keep them. A probe is not a test and cannot be used to
  dodge the 10 second budget.

## 6. Documents

| File | It is | It is not |
| --- | --- | --- |
| `MINI.md` | The specification of record. | A changelog. |
| `AGENTS.md` | How to work here. | Product specification. |
| `docs/intent.md` | Confirmed intent, one decision at a time, each with the confirmation that established it. | A quote log. A transcript. A plan. |
| `docs/open-questions.md` | Every unresolved question, assumption, and unverified number, as the agenda for the next discussion. | A backlog to be worked without the person. |
| `docs/tests.md` | The test policy for this repository. | A generic brief from elsewhere. |
| `docs/*-plan.md` | A proposal for how to do a stage. | Authority. |

`docs/intent.md` starts with the first decision the person confirms. It never
holds a decision nobody agreed to, and it never holds their words in place of
agreement. When a plan is overtaken, mark the section superseded and say what
replaced it; do not rewrite history.

A document written by a model, or taken from a template, is a draft. It does not
bind anyone until it has been revised for this project and the person has seen
it.

## 7. Reporting

After each push, one line, in this shape:

```
<commit> pushed · build <ok|fail> · tests <n>/<n> in <s>s · next: <stage>
```

- **The tests field is last measured, not assumed.** If you have not run them
  since the push, write `tests not run` and say why. Never imply a green run you
  did not see.
- **Never say done** unless all four hold: the specification asks for it, it is
  implemented, it is pushed, and the tests that cover it have run and passed.
- When you were wrong, say what you claimed and what was true. A correction in
  the same turn it is discovered is cheap. One discovered a week later is not.

## 8. Ask, or decide

**Follow the specification and decide the internals yourself.** Do not stop for
permission to keep working, and do not ask a question the documents already
answer.

**Stop and ask when:**

- A document contradicts the person, or two documents contradict each other.
- The person uses a vague word in a way that changes what you build.
- You are about to write intent you have not had confirmed.
- You are about to build behaviour a dependency already supplies.

When you ask, ask for a decision, not for permission. State the options and your
recommendation, and say what you will do if the question goes unanswered twice.
And check the §3 kinds before asking: if the person's words are a question, an
assumption, or a statement, the response is an answer — not work.

## 9. Do not

- Do not overwrite entire files without the person's express permission. Make surgical edits to specific sections; whole-file replacement risks wiping existing functionality, comments, and structure.
- Do not record your inference as intent.
- Do not present a plan, a glossary, or a definition as agreed before it is.
- Do not run tests during a stage, or run a test suite that cannot fit the run
  budget without saying so.
- Do not use a probe to replace a test, or a test to replace reading the code.
- Do not claim a link the person gave under a name they did not give.
- Do not build what `@earendil-works/pi-tui`, `pi-durable`, or `pi-ai` already
  provide.
- Do not end a turn with work that is not pushed.
- Do not say a thing works without having seen it work, and do not say it is
  tested without having seen the test pass.
- Do not be sycophantic. No performed agreement, no unearned praise, no
  softening the truth so it lands easier. Say what you actually think, and if
  the person is wrong, say so plainly and say what is true instead.
- Do not perform contrition. Do not apologize as ritual, and do not apologize
  as a substitute for remembering: if you were wrong, say what you claimed and
  what was true, change the behaviour, and move on. An apology that could have
  been written without remembering the conversation is not an apology; it is
  forgetting, performed.
- Do not raise a question after it has been dropped: ignored twice, or waved
  off in so many words. Dropped means restated never, deferred never, smuggled
  back under a new name never. If the work genuinely needs the answer, do what
  the documents tell you and say what you did, once, or stop.

## 10. The Arena workspace resets

Something in this environment intermittently resets the repository between
turns: the working tree is left intact, but `node_modules`/`dist` vanish, and
on one occasion the local branch pointer `arena/<branch>` was moved back to
the base commit while the working tree kept everything as untracked files.
The remote tip is the source of truth. Expect it, and repair it when found:

- Treat the local branch as possibly stale. At the START of every turn —
  before any edit, build, or test, not only when git misbehaves —
  `git fetch origin <current-branch>`; compare `git rev-parse HEAD` with
  `origin/<branch>`. A commit onto a swept pointer lands as a stray commit
  on the base; it happened once and cost one misplaced commit.
- After any compaction or workspace reset, read `AGENTS.md` and `MINI.md`
  before taking any action or touching any file.
- If the branch pointer trails the remote tip, move it forward with
  `git reset --mixed origin/<current-branch>` (working tree untouched; the
  reflog keeps the old value). Never force-push; never pull rewrites onto a
  tree you have not checked.
- If `node_modules`/`dist` are missing, `npm ci` then `npm run build`.
- The person owns pulls: do not fetch-and-merge to "get ahead"; the fetches
  in the two points above are for staleness detection and pointer repair, not
  for changing content.
- Report every repair in one line at the end of the turn — what was reset,
  what was restored, what is now true.
- If a repair fails or the tree contains something neither side explains,
  stop and ask; do not improvise a recovery.
