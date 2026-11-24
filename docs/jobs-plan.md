# Persistent Piped Jobs (`proc` + `J` handles + `jobs` view)

Status: accepted plan for implementation (supersedes Old branch's Windows design).

## Goals & Spirit (`SPEC.md`)
- Give Carto persistent, pipe-backed background processes (REPLs, dev servers, interactive testing harnesses) without the state-block bloat of Old's Windows.
- **Ephemeral runtime state, not Brain state (§2, §3.1):** Live processes exist in host RAM for the lifetime of the Carto host process. Nothing is written to `.brain/`, nothing survives a Carto restart, and every process group is killed on Carto exit.
- **Survives collapse (§4):** Collapse rebuilds the context while preserving the live `JobTable` so the agent can garden context and keep driving its running harness.
- **Zero buffer bloat in `<carto-state>` (§5.3):** `<carto-state>` reports only one compact status line per live/exited job when jobs exist (handle, label, running/exited status, unread line count, quiet/active indicator). Output lives in an in-memory ring buffer and enters model context only as ordinary ephemeral tool results (`R`) when returned by `proc`.
- **Shared workspace (§8):** The person sees and interacts with the same live jobs through a `jobs` book in the TUI (split-pane list + live output + bottom stdin/command input bar, `^o j`, sidebar under `WORKSPACE`).

## Components
1. **`src/runtime/jobs.ts`** — Procedural `JobTable` over Node `child_process.spawn` (`detached: true`, pipes only, zero new dependencies).
   - Handles: `J1`, `J2`, … (creation order, released on `stop`).
   - Bounded ring buffer (2,000 lines/job) + partial trailing chunk tracking for prompt-less REPLs.
   - Short settle on `start`/`send`: returns once output is quiet for 150ms, capped at `waitMs` (default 1000ms; `0` returns immediately). Never errors or kills on timeout; returns partial output so the agent continues asynchronously and sees unread/quiet/exit state in `<carto-state>`.
   - `AbortSignal` on wait cancels the wait immediately without killing the job (§9).
   - Person stdin writes are echoed (`> …`) into the ring buffer without advancing `agentReadSeq`, so the agent sees person-driven actions on its next `read`.
2. **`src/domain/state-block.ts`** — Optional `jobs` summary section rendered only when jobs exist.
3. **`src/runtime/tools.ts` & `src/runtime/carto-extension.ts`** — Single `proc` tool (`start` | `send` | `read` | `stop`) + `J` handle mention in `cartoInstructions`.
4. **`src/runtime/live-session.ts`** — Carries host-owned `JobTable` across collapses; never kills jobs on collapse.
5. **`src/ui/jobs-view.ts`, `src/ui/sidebar.ts`, `src/ui/jump.ts`, `src/ui/chrome.ts`, `src/ui/app.ts`, `src/runtime/headless.ts`** — `jobs` book in TUI (live output, send stdin, start new job, `SIGINT`, stop/remove), live updates, and `stopAllJobs` cleanup on exit.
6. **`SPEC.md` & `test/jobs.test.mjs`** — Align spec tables (§5.3, §5.4, §7) and cover runtime, collapse persistence, async indicators, shared stdin, and `JobsView` in `npm test` (≤ 10s total).
