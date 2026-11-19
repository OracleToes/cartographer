# Cartographer — the pair-programmer design

**Status:** retained source of product intent, refreshed 2026-11-16. It is not the delivery plan: `docs/atlas-attention.md` records the verified Atlas baseline, `docs/consult-mode-proposal.md` specifies the approved consultation target, and [the Phase 2 UI delivery plan](./ui-redesign-phase-2-architecture-plan.md) carries the active delivery sequence. The README documents the harness as it is; historical plans remain evidence in Git rather than active scope.

Rules of evidence, same as everywhere in this project: no live claims until a live run exists; measurements are bytes or tokens stated as such; anything not yet verified is marked open.

---

## 1. What this is

Cartographer is **one agent** with a durable project brain and finite attention, aimed at long-term goals. It is the same agent whether it is working alone in a collapsed context, in a focused context, or talking with the user. It is not a fleet, not a clerk, not an orchestrator of strangers. It is the working partner you hand a project to.

The target model is a large one (the user runs Qwen3.8-27B, byteshape GGUF, on llama.cpp), not a small one. Everything designed for 0.6B-class models — ceremony meant to stop the model making unrecoverable mistakes, prompts that patronize it, forking to read a file — is either deleted or re-examined on evidence, not retained out of politeness.

## 2. The frame

The user's own framing: *the guy from Memento* — a highly capable agent that can manage its own context and orchestrate long-running work. The Memento rules, taken seriously:

1. **Memory is the scarce resource.** The method is: externalize what matters, keep the artifacts cheap to consult, trust nothing that was not verified.
2. **The context is working memory; the brain is long memory.** The brain lives in `.brain/`, in files the user can read, edit and commit. What is not in the brain is not in memory.
3. **Provenance everywhere.** Every artifact says when, by whom, and from what. A 27B will write notes that are wrong or stale; the design must make re-verification the cheapest operation, not the most faithful annotation.
4. **Re-verify sources, don't worship summaries.** Recall by id, re-read the file, check the digest. The agent that says "my note says X, but let me check line 40" is the agent that survives a month-long goal.
5. **The principal is in the room.** The user steers by talking (first-class `chat`), approves changes, answers questions, edits any artifact by hand or by the same actions the agent has. The brain is a shared thing; the relationship is a dyad.

## 3. The brain, the context, the talk

- **The brain** (`.brain/`): the ledger (goals/questions/notes), the plan, the atlas (project map + node graph), the assessment (one whole text about the project), reports of finished work, the catalog (identity/versions), the context store (what a collapse keeps), and the raw Durable transcript. The user edits any of it; the agent sees hand-edits at the next step.
- **The context**: what the model can see *now* — the system prompt, the copied top block, the collapse block, the work since, and the two per-request blocks (state, windows). It is a cache. It is rebuilt mechanically at collapse.
- **The talk**: the user↔agent conversation, kept word for word up to `chatWindow` across collapses, and *both parties hold the pruning tool*: either may edit any message (`e`, and agent-side the soft-forget contract for messages). Poor prompting and mistakes are pruned at the source, so intent stays sharp. The user is a gardener of the conversation, not a spectator of it.

## 4. The two modes

The user's direction, recorded verbatim in substance:

- **Default mode.** The agent initiates, but each concrete move revision under an intent envelope is submitted for asynchronous review. It works approved moves and keeps going on everything that does not depend on a pending answer. Approval is per exact move revision, asynchronous and non-blocking — as the Requests machinery already works.
- **Yolo mode.** Approval is off. The harness does not decide whether the agent may act; it only *facilitates autonomy*. The agent's own judgment governs. (`/yolo` remains never-remembered, as today.)

**The line that holds in both modes:** yolo removes the *human* gate; it never removes the *mechanical* ones. Project-root confinement, the sandbox and its network control, checkpoints and `/undo` around change tasks, `.brain/` and `.git/` protection, the ignore rules — unchanged in every mode (user-confirmed 2026-11-15). Yolo says "I trust your judgment," never "delete what you like."

One documented departure from the mechanical line is the user's own hand on the sandbox switch: `"bwrap": false` in the settings holds for every run, `--no-bwrap` carries one run, and `/bwrap off` switches it mid-session (never remembered — every start is sandboxed again). With it off, change tasks' commands run directly on the machine, outside the project; the user types it, the approval and checkpoint rules still apply, and the screen says so. The main agent's read-only lane is unaffected by the switch — it is held by bubblewrap itself: with no working sandbox the lane is refused outright, never run unconfined. Yolo does not imply any of this, and nothing the agent does can flip any of it.

## 5. The charter — what the agent does when nobody is talking

On start, and after every wake with nothing pending, **the agent initiates**. It does not wait to be addressed. The standing duty:

1. **Look.** Map the project: what it is, how it builds, how it tests, where the entry points are, what the docs claim. Record what it learns in the atlas and the assessment.
2. **Form hypotheses and record them** — in the ledger (a finding, a suspicion, a question for the user) and, when a change is warranted, as authorization envelopes with narrow declared moves (default), or under those moves directly (yolo).
3. **Verify.** Test its own hypotheses when it can. Update or strike the ones reality refutes.
4. **Work what is approved.** Exact move revisions in dependency order, one at a time, with checkpoint, evidence review, acceptance and undo discipline.
5. **Deepen the map.** Re-map what changed; close the gaps the atlas still shows; find weaknesses worth reporting or fixing.
6. **Sleep only when nothing remains.** `sleep` is the answer to *"I can find nothing to do"* — reached through a written checklist, stated to itself first: no user message waiting; no wake owed; no approved move ready; no open question owed to the user; no hypothesis in the ledger untested; the atlas covers the in-scope ground at the tree depth in view; no fragility found-but-unplanned. Only then sleep. Sleep is not a mood; it is a conclusion with evidence.

In **default mode**, the user's silence means "not authorized yet," not "don't look." Looking is free. Changing waits its turn in the queue — and the queue shows everything waiting in one place (the Requests view), which is what makes async approval scale past a handful of move revisions.

## 6. The dispatch contract — reads are free, changes go through the gate

**Settled** (user-confirmed 2026-11-15; shipped):

- **Read-only is inline, for every context.** Project-file `read`/`search`/`list`, durable `list`/`read`, report reads, `shelf` operations — no nested conversation, no report journaled, no permanent composed row, no second-guessing. One public `read` call is one file; up to the read-file bound from one reply are a transient tail batch sharing one output ceiling. A later successful batch replaces that tail without collapsing context, so source material needed afterward belongs on `shelf` and lasting conclusions in the durable brain. The bounds that already exist stay (file size cap, line clip, range cap).
- **Changes go through the one gate.** File create/edit and command starts require one live approved change move revision carried by a focus — exact targets, capabilities, hard budgets, checkpoints, sandbox/network policy, report evidence, acceptance and undo. Envelopes are intent only; only the orchestrator edits them and accepts a report. Default mode: move revisions wait for the user. Yolo skips approval only, not the mechanical contract.
- **A `task` focus is a deliberate tool, never a toll booth.** Uses: (a) carrying out one authorized move revision (isolation, checkpoint, evidence, undo); (b) a bounded attention firewall the agent *chooses* for a narrow read-only question — an investment of context hygiene, not a tax on looking. Its reply budget remains small; broad investigation is split into inspect foci or kept inline.
- **A report is journaled for real tasks**, i.e. work the agent delegated with a brief (user-confirmed 2026-11-15) — never for one-shot reads or tool calls. Reports exist so delivered work can be recalled by id.
- The return-time yes/no brain-review checkpoint rides with real tasks only, not with every book operation.
- `wake`/`sleep` remain orchestrator-only. No nesting of foci. No `task` from within a focus.

The automatic out-of-brain focus dispatch (`externalWork`) and the `mainLooks` refusal are deleted; the rest of this section is consequence of that.

## 7. Memory — a cache, a brain, and a breath

- **The collapse is a breath, not a crisis.** While the agent rests and enough would go; when a goal closes; at the ceiling — the context is replaced mechanically with a fixed, known keep-set (records of finished tasks, the shelf, the talk, plus a verbatim carry of what the last reply just did). No summarization, no negotiation, no request-shaped ceremony that demands a 0.6B-grade act of metacognition in the least capable moment of the window.
- **The agent tends its own context.** The state block tells it the truth (how full; what stands in full with recall by id) and instrumentation (`/context`) is always available. The 27B manages its working set deliberately; the harness backstops at the ceiling. Fold is how it shrinks what it carries mid-session; recall is how it brings anything back.
- **One-line provenance in the state block, not diffs.** (Proposal — see Open decisions.) "`src/foo.mjs` changed since its snapshot" is enough; the diff is a tool call away, not prompt cargo.
- **The keep-set is small on purpose.** Finished tasks as one-liners + recall; the shelf pinned by the agent; the talk capped at `chatWindow`. Identity, plan, ledger, atlas and the assessment are never in the conversation — a collapse cannot touch them.
- **The ceiling does not wait for a tool round.** The collapse is normally decided after a round of tool results (`afterMainCall`); a stretch of plain replies never reaches one. Since 2026-11-16 the plain-reply path checks the same line itself: at it, the run ends, the rest path collapses with a forced marker even with nothing droppable (the reset costs one re-read of what was kept), and the task path checks before every request. A notes-only run is never allowed to grow the window without limit.
- **Nothing is lost, anything is forgettable.** Soft-forget (message edit) is the confirmed contract, unchanged: the agent may drop its messages from view; the Durable transcript remains, append-only, forensically recoverable. Reclaiming storage is a separate lifecycle, not this design's job (see Open).

## 8. Atlas attention — claims stay durable, work gets a bounded trail

The atlas graph is durable project knowledge. Its attention record is a bounded derived trail, stored beside the graph but never used as evidence that a claim is true, false, archiveable, or removable.

- A nonempty factual batch advances one bounded work epoch. Successful deliberate reads and shelf placements, explicit Atlas use, task/checkpoint changes, file drift, and broken links may supply facts. The interpretation is centralized in Atlas rather than being independently re-scored by tools or screens.
- An observed active node is direct hot. Its inbound or outbound neighbours are warm for exactly one graph hop; warmth does not recurse. A touched project path that maps to no active node remains a visible mapping gap rather than causing a guessed node to be created.
- Verification pressure is independent: staleness, missing fingerprints, broken graph links, and mapping gaps belong under `Needs checking` even when the related node is hot. The next action is re-read, verify, relink, or map — not an automatic factual rewrite.
- Explicit focus is a durable lens on one existing node or confined project path, with a short reason and author. It persists until `focus` visibly replaces it or `unfocus` clears it. A running declared move adds only a temporary target overlay and never replaces the lens.
- Cold isolated nodes can be explained archive candidates only. Active work shows their count, while idle/maintenance work may show their detail. Archive is reversible, confirmation re-heats, and only fresh direct verification justifies permanent removal; that is deliberate operating practice, not a durable deletion-receipt subsystem. Nothing decay-related auto-archives or auto-removes a claim.
- The request-tail local text map is the one projection for focus, active work, hot, nearby, mapping gaps, checking pressure, and candidates. It is freshly derived; the frozen top-of-context graph/tree remains structural and cache-friendly.

## 9. The shared brain — one engine, two doors

The pair-programmer dyad has a mechanical consequence: **the UI and the agent must be clients of the same operation engine, not two implementations of overlapping gestures.**

- Today: the agent has `book target/action` (validated locally, actionable errors); the screen has the Hands view (shelf/rows/reports with `f`/`v`/`x`/`d`, curated rows via `/row`), the Carto tab (ledger/plan/atlas), and assorted `/` commands — overlapping but not identical, and each hand-implemented.
- The design: the `book` capability table is the single source of truth for brain operations. The model's door validates per `target`/`action`; the terminal's door performs the same operations inline (with the same checks and the same messages) or through existing commands; the screen becomes an editor *of the same artifacts*, exposing the same verbs (`fold`/`recall`/`archive`/`shelve`/…), with the same refusals.
- Concretely, the brain on screen gets the parity the agent has and lacks today: authorization envelopes and moves with their revision, targets, proof, capabilities, budget and lifecycle state, ledger edits, atlas nodes, the assessment, reports, shelf placements — all editable in place, all with the same preconditions (expectedVersion) and the same messages. The user gardens the brain as fluently as the agent does.
- The chat remains the steering wheel: always available, reaches the agent immediately (it interrupts a turn naturally via the next result), and every user/agent message stays editable by both parties.

## 10. What the harness guarantees, always

- Declared moves are the only way project files change; approval is per exact move revision and async; checkpoints bracket every change focus; `/undo` reopens that move as a fresh unapproved revision; `.git/` and `.brain/` are never written by change foci; project-root confinement including symlinks; sandboxed commands by default with per-move network control. Shell scope is checked from the final checkpoint diff rather than claimed as preventative confinement.
- The agent cannot brick anything it does not own: it cannot touch the user's `.git`, cannot edit the plan of *its own* program directory without a project there (and it has no standing duty to edit its own harness at all — see §11), cannot erase the transcript.
- Every failure is actionable: local validators fail closed with a message naming the exact field at fault; unresolved references report their status (`live | stale | deleted | …`); unsupported operations list what *is* supported. If the 27B fails, it fails in one round trip with the fix in hand — never a silent swallow.
- Nothing is lost silently: soft-forget never claims erasure; the checkpoint journal contradicts any task that claims a change it did not make.

## 11. What this design deletes or parks

- **Stage 6 clusters** (recency-reordered user-area memory summaries): consciously deferred; the substance of the deferral stands. **DECIDED 2026-11-16, and shipped the same day: the collapsed block is typed, mechanically, with a local hour:minute on every line — the record and the salient notes chronological, a structured shelf listing before the contents, the talk verbatim and capped at `chatWindow` with each saying minute-stamped, and one line per call of the stretch (minute · call → outcome, the newest that fit under `callsTokens`). No model writes any of it; the keep-set is unchanged, so this is §7 with better typography, not Stage 6. The Context tab shows the same objects as rows with the verbs they carry elsewhere.** The user chose this deliberately, knowing the tension; it is not evidence for unparking Stage 6.
- **The handoff ask** before non-user-initiated collapse: the 0.6B-era metacognition gate. **DECIDED 2026-11-15 (O1): opt-in (`handoffQuestion`), never the default.**
- **Stage 4A focus-dispatch for out-of-brain operations** (items 6–7): superseded by §6. Brain records ran direct already; the rest now runs inline too. The `externalWork` auto-dispatch and `mainLooks` refusal die.
- **The 17-to-13 tool era artifacts**: the standalone `atlas` tool (already folded, `7571490`), the schema-replay lifecycle (already deleted), and any future temptation to reach back for them.
- **Recursive self-improvement as a standing duty**: cut (user-confirmed). The agent maps and maintains *the project it is aimed at*. Its own harness is fixed furniture unless the user aims it at the install directory deliberately, in which case changes still go through the same declared-move gate.
- **Plugins**: not built, not designed here. **Retention/prune lifecycle** for old transcript (separate, unresolved; explicit user conversation before any design). For the record, what grows on a long goal with nothing ever reclaimed: the Durable transcript, the catalog, and the index memo under `.brain/catalog/`. Parked until the user wants it designed; the cost is visible and the mitigation is none. **Stage 8-scale verification**: deferred; to be reconsidered only with live evidence from a real session.

## 12. Decisions (small, explicit)

Decided items are marked **DECIDED** with their date; the rest stay open.

O1. **Handoff ask — DECIDED 2026-11-15: opt-in, default off.** It stays available behind a config the user can turn on (`handoffQuestion`), never the default; collapse carries the last reply mechanically.
O2. **Curated context rows vs ledger notes — DECIDED 2026-11-15: merged; shipped 2026-11-15.** The row species is gone (`context add/edit/done/remove/before` and the Hands section with `/row` are retired). A note that must stay in view carries `"salient": true` (only notes); a salient note is marked ● and stands in the state block and in the block a collapse keeps, re-read from the ledger at the boundary. Legacy curated rows fold into salient notes on first read after the update (dedupe by text; interrupted folds resume; reports nothing on an unreadable ledger). (Overrode my recommendation to keep both.)
O3. **Shelf-change notices in the state block — DECIDED 2026-11-15: one line per changed file** (file name + line delta). The diff is available on demand; it is not in the notice.
O4. **Stage 6 clusters.** Confirm: deferred, not promised. **Update 2026-11-16: the keep-set is unchanged; its presentation in the collapsed block is now typed and minute-stamped, and the objects are individually addressable in the Context view (`1 task · 1 note · …` unfold). No summaries, no recency reordering, no model call at the boundary — §7 stands. The user's own decision, with the tension seen.**
O5. **A read-only command lane for the orchestrator — DECIDED 2026-11-15: yes.** The orchestrator may run read-only commands inline, like any other read: tests, lints, git status and the like, on its own authority, without an envelope, move or approval. It is enforced by the sandbox, not by discipline: the window mounts the project, the brain and .git read-only and never reaches the network (src/sandbox.mjs readOnly profile), so a command that must write or reach the network still needs a declared change move.
O6. **Measurement gate.** May a live 27B session be used as acceptance evidence, or is it observational only (observation + manual review; no pass/fail claims)?
I1. **Initiation — DECIDED 2026-11-15.** A config setting and a `/command` toggle govern whether the agent self-initiates on start and after wakes with nothing owed; it self-initiates by **default**. (Not prompt-only, and not a forced startup note.)

## 13. What does not change

The identity catalog and `{ namespace, kind, id, version }` envelope; expected-version semantics and stale-write refusal; idempotent replay; the namespace/fork policy; `.cartoignore` discovery semantics; soft-forget's transcript-preserving contract; checkpoints/undo; plan exclusivity for the orchestrator; wake/sleep exclusivity; the Requests view and the approval flow; the ledger limits; chat as a tool of both contexts. None of this is relitigated here; all of it is the substrate the charter stands on.

## 14. Honesty policy

Every change verifies offline first (`node --check`, module imports, stub probes, no live model claims). Live evidence is gathered once, deliberately, on a throwaway project, and reported as what it is: one session, one model, one project. Nothing in this design is verified by assertion. Where the design is wrong, a live session is how we find out.
