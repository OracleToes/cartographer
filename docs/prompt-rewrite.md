# The prompt rewrite — plan and record

**Status:** implemented 2026-11-15 (code and offline suite green: 37 passed, 0 failed, 1 skipped). Live testing by the user pending — no live claim is made until it happens. **Addendum 2026-11-16:** the books this period mentions (`assessment`/`practice`, `assess`, `carto-books.json`) were retired — the assessment is one whole text written through `book` (target=assessment, action=write), and the practice book is gone. Atlas node `kind` is also gone. Suite green at the time of the addendum: 55 unit + 48 integration passed, 1 skipped.

This document plans (and records the decisions behind) the full rewrite of every agent-facing prompt surface. `docs/design.md` is the source of Intent; this file is the working plan for one deliberate piece of work against that intent. It is kept, not folded back into design.md.

## Why

The review of 2026-11-15 found that the Memento frame — the design's own §2 — never made it into a single agent-facing word: no surface told the agent that its memory is suspect and re-verification is the default. The prompt was written for a much weaker model and carried ceremony a 27B does not need, duplicated itself in three places, and spoke in a split persona ("You are the same Cartographer agent…", "Cartographer:" narrating notes). The state block was the one surface that was already close to the target voice, and it is the one surface that is never stale.

## Decisions (user, 2026-11-15)

1. **Baseline.** The rewritten prompt is the benchmark baseline; the stale wording is not preserved for benchmarking.
2. **Time.** The agent uses the clock only from the state block, and only when time is relevant. It is not concerned with time in the record-keeping sense. Its concern is the current state of the project and keeping its understanding of it up to date while it is not working.
3. **Trust.** The state block is trusted fully; everything on it is live. It is also the place the agent learns when and where the shelf is outdated — it is used that way. Anything that cannot be live must say so; nothing else is read with full trust.
4. **Refactors.** Elegant solutions; any refactor must align with design.md Intent.
5. **Wording discipline.** First person asserts records and method, never invented biography. The Memento framing is ours and is never named in the prompt. The user's name is the only proper name; the harness never introduces a competing staff writer.
6. **Modes (the metacognition rule).** The prompt never tells the agent which mode is the default. In yolo mode — or after a collapse that began with that state — the agent simply *is* in that mode. The prompt carries only the workflow of the present state (e.g. the state block lists change items running without /approve while approval is off), never commentary that approval was "switched off" or that something else is the norm. No "approval is off" self-talk; no exception framing anywhere. The same discipline covers the sandbox/direct-command switch.
7. **design.md.** Stripped to the source of Intent (slicing and staging deleted; this document keeps the staging).
8. **Verification.** Offline checks only in the sandbox. The user runs the live testing after the refactor.

## The surfaces (all rewritten)

- **A. The standing system prompt** (`src/prompt.mjs`, SECTIONS): one mind, the dyad, roles, talking, taste, plan, goals, ledger, atlas, assessment, running, context, the charter (duty), sleep, state, code. Ceremony triplication removed; the assessment section now names the real `book` targets (`assessment`, `practice`), and the books' soft limits are stated where the books are described.
- **B. Per-request blocks** (never stored): the state block (`src/state.mjs` — head, FIRST, MAP, direction(), the approval paragraph (yolo only), commands(), clock(), atlasText()), the plan's authorization line (`src/plan.mjs`), the windows block head, the copied top block (`src/top.mjs`).
- **C. Stored note blocks** (kept across collapses): wake/start/noted/REPEAT_NOTE (`src/wake.mjs`), the collapse front block and the task-step block (`src/context.mjs`), the focused-context brief header (`TASK_HEADER`), the handoff family (`ASK_MAIN`, `ASK_TASK`, `HANDOFF_IN_TURN`, `HANDOFF_NOTE`, `TASK_HANDOFF`).
- **D. Tool descriptions**: the TOOLS table in `src/prompt.mjs` and every per-tool description field under `src/tools/`, first person throughout.
- **E. Call-time text**: refusals (`REFUSALS`), error strings, tool-result lines, the engine's collapse "why" strings, the harness's loop stop. Voice at call time: terse, factual; an error keeps the field at fault and the fix.

## Load-bearing anchors

Block heads are matched by regexes and by `isFront`/`isNote`/`isNoChat`/`without*` across `src/{state,context,wake,top,request,harness,windows,engine,screen/views}.mjs` and the tests. All such heads now begin with one shared signature, `RECORD` (`src/voice.mjs`):

> Written by me, from my own records, not by the user's hand.

Strip patterns import `RECORD` and build an escaped anchor, so the wording moves in exactly one place. Any future block written by the harness starts with `RECORD` and nothing else.

## Standing practice after this rewrite

- New agent-facing text is written in the same voice: records and method only; the user's name is the only proper name.
- The state block stays the only fully live surface. What cannot be live says so where it stands (the shelf does; the top copy does — it always carried its as-of line).
- `docs/design.md` changes only when Intent changes; working notes and staging land here or in git history.

## Open (carried, not resolved by this work)

- `FREE_TAIL=3` — lines of a free window shown per request; unresolved tuning question.
- Shelf-snapshot line-number rendering in the state block — open.
- O4 (Stage 6 clusters) — deferred, not promised (design.md §11).
- O6 (measurement gate: is a live 27B session acceptance evidence, or observational only?) — unanswered.
- The ten-second offline suite budget.
- Stage 6 / any further slicing of design.md Intent — not authorized.

## What this did not change

Gates, confinement, checkpoints/undo, the plan exclusivity, wake/sleep exclusivity, the approval flow and Requests view, the ledger limits, soft-forget's transcript-preserving contract. The rewrite moves words, not semantics; every gate behaves exactly as before.
