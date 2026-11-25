# Reactive state engine

**Status: implementation in this change; orchestration integration is future work.**
The goal is to make the state block useful steering derived from observable
conditions, rather than repeat a static workflow or infer intent from counts.
The existing direct Carto remains the only implemented agent mode; the separate
orchestration plan is not implemented here.

## Design

- Keep one fresh trailing user-role state block per request and do not persist
  or accumulate old blocks. The same observations give the same guidance;
  rendering a UI preview cannot consume an event or change agent state.
- Gather current Brain, frozen-head, filesystem, jobs, settings and visible Pi
  messages at the existing request boundary. Interpret observations with pure
  functions, and render them where the relevant facts already appear. Do not
  hide conditions behind an arbitrary cue limit, score Atlas or infer intent.
- Keep the known-window estimated collapse warning and its existing direct-mode
  behavior. Unknown window is unknown, not a percentage. A warning is not a
  guarantee of output space.
- Explain live Atlas attachment, pinned file and pinned read-result drift in the
  stale section. Distinguish a newer file from an unavailable one, and say when
  a fresh read differs from refreshing the frozen pin. Mtime is a signal, not
  proof a note is wrong. Don't imply the tree is a complete change list.
- Jobs keep their existing status, unread count and exit signal; suggest reading
  only when output is unread. Never ask to stop a job merely because it exited.
- Use Pi's committed tool-result `isError`, matched by call ID to the most recent
  completed visible tool round. Show the tool and its result handle when known;
  keep the cue while that remains the latest completed round. It does not claim
  the error was fixed or the task failed. A later round replaces the observation.
  Do not infer shell intent from command text.
- Remove the static `flow` and count-based Atlas, Ledger and pending-write
  nudges. Preserve existing marks, ownership, pins and tree page information;
  do not reveal archive contents or auto-delete, auto-mark, or impose a limit.
- Report the in-memory write list as session-observed writes, not an exhaustive
  history since the rebuild: reopening resets it. Brain and head remain the
  sources of truth.
- Keep rendering pure and capability-aware. The adapter supplies what tools are
  available; no cue should send an agent to a missing tool. Future orchestration
  and focused contexts must supply their own role/capabilities, task phase,
  local pins and chosen context. Their warning/report state machine and GBNF
  enforcement belong to the orchestration implementation, not this change.

## Verification

Cover stable/clearing conditions, unknown capacity, stale and inaccessible
references (including external symlink pins), unread/exited jobs, failed and
successful tool rounds, handle correspondence, and preview/replay behavior.
Keep existing collapse, context, direct-mode and archive tests. Run the complete
`npm test` suite within its ten-second budget before committing and pushing.
