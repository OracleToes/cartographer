# Regenerative orchestration: proposed revision

**Status: regenerative coding is approved in principle; its detailed design is
being decided.** This proposal revises the approach in
[orchestration-plan.md](orchestration-plan.md), which remains as a record of the
original decisions. The person's decisions below are recorded as we discuss
and commit them; other recommendations and questions remain proposals. This
document does not change `SPEC.md`: resolve the remaining details and update
`SPEC.md` before implementing agreed behavior.

The person wants Carto to maintain a structured, standard project definition,
using ***plain if it is applicable or another method if not. Existing code that
conforms to a well-defined specification is kept. Only behavior that does not
conform, is not adequately described, or is new is considered for regenerative
work; an inadequate description may need a specification change rather than a
code change. This is not permission to regenerate the whole project whenever a
specification changes.

The proposal preserves the person's other decisions: direct Carto continues to
work as it does; orchestration is a separate mode; only one model runs at a time;
task work changes the real project and shared Atlas/Ledger rather than a
speculative branch; every task return normally performs a full main collapse;
and a task overflow preserves partial work and sends main an honest system
notice. Archive grace advances normally on each main return collapse, even when
returns are close together. Other unresolved boundaries remain decisions, not
assumptions.

## Dependency and duplication audit

The foundations are still dormant and incomplete. An audit of the installed Pi
1.5.2 APIs and Carto's existing collapse paths found:

- The session inference gate had reimplemented stream forwarding and provider
  failure messages. It now uses Pi AI's exported `lazyStream`, retaining only
  Carto's FIFO admission and cancellation policy. Pi Durable schedules tasks but
  does not expose a session-wide model inference semaphore; Pi's code-mode
  concurrency bound applies to one script, not all Harness requests. The gate
  still does not coordinate other sessions, processes or provider-side deferred
  work. This gate is also used in direct mode.
- The delegate's initial input request ID was spelled independently in
  admission, retry, checkpoint and sweep code. One shared identity function now
  supplies those paths; Pi still performs submission deduplication.
- Child creation and ownership, documents and transactional admission, active
  context derivation, task abortion, and request replay use Pi's APIs. Return
  record marks, pin refresh, freshness, archive and projection planning reuse
  Carto's ordinary collapse/domain code. These prospective planners are not an
  integrated collapse, journal, or proof that a source can be deleted.
- The manual source-store seal is a schema-dependent change detector, not a
  Pi-provided snapshot or lock. Pi's public SQLite storage opener runs migrations,
  so it is not a substitute for Carto's read-only inspection. The seal is a
  maintenance and compatibility risk; unknown schemas fail closed. No equivalent
  public Pi API for a read-only logical store fingerprint was identified.
- Input checkpoints, return barriers and provenance checks encode Carto-specific
  loss-prevention rules that Pi's abort and scheduler do not provide. In
  particular, Pi can withdraw queued input, and throwing a generation hook is
  not a fail-closed barrier. These checks are not a writer lock; source and
  destination sealing and end-to-end recovery remain unimplemented.
- Shared ephemeral restoration checks Pi's actual written entries and derived
  contributions rather than trusting request-ID deduplication, and its Brain
  acknowledgement compares the restored archive snapshot before deletion. This
  also protects direct mode. A dormant child-restore helper uses the same Pi
  placement checks and a durable source-to-passive-conversation mapping, without
  putting child content into main. These cross-store checks are not a writer seal;
  changed or omitted content remains for recovery, and host routing is not yet
  implemented.

This audit does not prove every custom guard necessary or complete; future host
integration must re-evaluate them against the then-installed Pi APIs rather than
recreating Pi scheduling, context or storage behavior. The source-deletion
guard and startup rejection remain in place.

## Implementation progress

The first foundation reserves and validates a per-project execution-mode
preference in `.brain/settings.json`, defaulting legacy settings to direct. It
is not an orchestration implementation: no UI enables it, and an attempt to
open a project whose settings request orchestration fails explicitly rather
than silently using direct mode. A dormant Pi Durable conversation document
can retain one handoff within a generation, with distinct delegate reports,
person-ended reasons and missing-report failures; it is not a scheduler or an
end-to-end recovery protocol. A returned handoff now crosses the full collapse
through a transfer record committed with the Brain sweep, verified before source
deletion, and restored into the next conversation before acknowledgement.
Unfinished or ambiguous records block collapse instead. This assumes generation
writers have stopped and does not implement cross-process locking. Pi stream
requests and deferred polls within one live session now pass through a single
inference admission queue, including cancellation before dispatch. Polls do not
protect against provider-side inference between submission and polling; other
processes and sessions are not covered. A test exercises a separate Pi
conversation. A dormant transaction helper now creates a tool-task-owned child
and marks the handoff running atomically, reusing the same child on replay and
refusing ambiguous ownership. Its agent uses only explicitly selected tools and
extensions. A dedicated Pi tool records a structured delegate report in the
handoff, with idempotent replay and conflict refusal. A dormant return-admission
helper uses Pi's transactional submissions and request IDs to present a return
to main, retaining the handoff until that input is answered and checked before
clearing the slot. Pi's ID deduplication compares submission type, not content:
Carto refuses an unmarked existing request and checks the original entry's text
and provenance on marked retries and acknowledgement. This is not proof of the
model's request; the host must seal context writers and control request hooks.
The caller must first perform the return collapse and must handle unanswered inputs. A dormant Pi delegation tool composes the child and
report foundations, with request-ID replay and an explicit missing-report
failure; a test reuses Carto's scoped read tool for capture. Both delegation
and report now fail closed unless their durable Pi tool task references a
model-issued assistant entry with exactly that one call. Nested callers are
disallowed. Other calls in a mixed round may still run normally; rejecting the
delegation does not roll them back. Initial child input admission now checks
the handoff and child ownership in the same Pi transaction, refusing to start
new work after a return; replay uses the same request ID. A durable child
identity and a request hook in the report extension now hold later child requests
once the matching handoff returns or begins ending, including a queued follow-up
Pi starts on the report boundary. A missing or inconsistent identity also holds;
the host must retain the extension, stop the held run and preserve the input,
and a request already past the hook still needs cancellation. This is not the
person-input routing or recovery implementation. A dormant immediate-end
control now records the person's reason as an ending intent, checkpoints both
conversations' pending inputs before aborting the child's ordinary Pi work,
then records a person-ended return. If checkpointing fails, it leaves the
ending intent and inputs intact for recovery rather than aborting them. A restart helper requires
Pi scheduling to remain paused and aborts the owning main run before resuming;
its unanswered inputs still require host handling. Before the recovery abort,
a dormant transaction checkpoints active main and delegate run and inbox input
content, submission identity and entry metadata in the source generation,
excluding the delegate's own initial task instruction. It validates child
ownership, reuses the snapshot on retry, and refuses ambiguous inputs or queued
context writes. The host must seal both conversations' input admission during
capture and recovery. Dormant helpers scan Pi's storage-level main and child
submission records for unanswered inputs, including withdrawn queue items; the
child scan excludes the delegate's own task instruction. The immediate-end and
restart-recovery paths use them after checkpointing and before abort, compare the
results against the saved checkpoint, and recheck the observed records and
ownership in a Pi transaction. The recheck also compares current live and queued
inputs to the original checkpoint, refusing new or changed inputs even when a
storage scan has not marked them unanswered. A retry still retains the original
copy and tolerates captured inputs withdrawn by an earlier abort. Pi's transaction
API does not expose a submission scan, so the host must seal admissions across checkpoint, scan and abort, and
provide the actual storage used by the Harness. The checkpoint helper alone does
not scan. A missing input blocks further abort, but Pi may already have discarded
its content: detection is not recovery. Older unanswered main inputs also block
unless present in the checkpoint; separately handled inputs have no durable proof
of recovery here, so this deliberately favors preservation over availability.
A dormant normal-return helper now validates the returned handoff, owner and
source barrier, captures pending inputs and performs the same scan before the
host aborts held work. It rechecks handoff, barrier, owner and checkpoint around
the scan, preserves the checkpoint on failure, and refuses to capture while the
initial report run is still settling. It does not itself stop work or complete
return collapse: a host must seal admissions, withdrawals and source work,
provide the matching storage, and coordinate abort, journal and replay. An explicit, dormant collapse
path now transfers the checkpoint with its matching handoff using the existing
Brain journal and verifies the source barrier and both documents. Placement is
atomic in the destination; conflicts preserve both copies. Ordinary collapse
still refuses an outstanding checkpoint, and ordinary session opening refuses
one after placement. A dormant staging helper places the preserved inputs as
ordered user-context entries before return admission using Pi transactional
writes; it preserves content and entry metadata but does not reproduce Pi's
original steer/follow-up submissions. Admission and acknowledgement also check
Pi's derived active context for the staged contributions and recheck its bounds
and receipt on the transaction line; omitted or edited inputs block. The host
must still seal context writers from staging through answer and acknowledgement,
and prevent other request hooks from changing the inputs. Checked receipt and
checkpoint clear only after the return is answered. A dormant destination preparation now composes
transfer placement, resumable staging and return admission; retry reuses the
admitted request, and acknowledgement still requires a completed answer. The
existing direct-session transfer placement is shared, but direct opening still
refuses a pending checkpoint. The host must install the main barrier and seal
other admissions and unrelated work; Pi's transactional staging may enable
scheduling. Host admission sealing, control routing, and end-to-end ordering
still need integration. This preserves data rather than
pretending the return path is complete. A missing-report failure now carries
Pi's unanswered reason and detail, including a provider overflow message when
provided. A separate dormant context-limit extension uses Pi's approximate
context estimator and a host-supplied model/window/reserve policy. It commits a
handoff, generation and request-cutoff marker at the threshold, adds reporting
guidance for that request and its retries, blocks new non-report calls, and
holds later requests for host abort. It is not connected to the delegation tool
or controls. The estimate can overshoot; the model may ignore the guidance or
fail. Pi recovery can replay an already-recorded tool intent without calling
beforeTool, and other hooks could replace the guidance. The host must control
extension selection and ordering, policy, recovery and input preservation;
this foundation alone does not guarantee forced reporting or a safe return.
If a delegate settles without a report after the marker, the dormant delegation
tool checks the marker against the child, owner, generation task and cutoff entry,
then identifies the estimated threshold in its failure while retaining Pi's
unanswered reason and detail. A conflicting marker blocks that attribution and
preserves the handoff. A dormant system-stop path now records a distinct
context-limit ending intent for a verified later request, reuses the input
checkpoint and unanswered-input scan before aborting the child, and records a
missing-report failure. Paused-scheduler recovery reuses the existing owner
chain and checkpoint recovery, retaining system provenance. A person's explicit
end takes precedence and retains person provenance. The host must invoke this
only for its held-request notification, seal admissions, provide the actual
storage and perform return collapse and input replay. The transaction checks a
later request but cannot prove the hook is still holding it, and does not lock
external writers. Recovery preserves partial project work and does not cross background boundaries. The
host must still route the control, handle unanswered and queued inputs, and
perform return collapse.
A dormant main-only Pi generation hook now holds requests in the source while a
handoff exists, including queued main input after termination. It fails closed
on read errors and wakes only on abort. A source-generation marker prevents
return admission there; after collapse a destination admission marker, the
exact return input and its live submission identity allow main to reconcile.
A later queued run is held until separately handled even if the return remains
in its context. This hook is not a global model
lease and the host must install it in main, abort blocked requests, and preserve
their inputs. Pi's terminate control alone does not stop a mixed tool round. These pieces reuse Pi's owned
conversations, schema validation and commit semantics, but are not yet a
complete delegate runtime or UI. A dormant file-evidence helper fingerprints
an explicit list of regular inputs and rechecks content and resolved target,
using Carto's existing path guard. Missing, unstable or invalid inputs are
unknown, not conforming; a match is limited to those inputs at the check and
is not proof that they were assessed or that the list is complete. It is not
an evidence store or an atomic project snapshot. Orchestration recovery, the
parser pilot, capture workflow and controls remain to be built.

**Return-sweep integration blocker:** `readGenerationEphemera` currently reads
entries from every Pi conversation in a generation and applies the newest head
marker across all of them. A delegate's head can therefore hide earlier main
entries, and unrelated child entries can be mixed into the main sweep. The
existing direct-mode behavior must not be silently changed. Before exposing
orchestration, make the return sweep conversation-aware, preserve the appropriate
per-conversation archive data and head boundaries, and test actual main and child
stores through collapse and recovery. Pi's SQLite storage open runs migrations,
including writes, even when the Harness is read-only, so it cannot simply be
opened over Carto's read-only source to derive contexts. Archive restoration
currently targets main and needs provenance-aware handling; the current sweep's
text-based Chat deduplication can suppress unrelated child input. Do not put the
child's transcript in main's context. As an interim fail-closed measure, ordinary
collapse rejects any source with additional conversations, even if its handoff is
missing or cleared; committed recovery likewise preserves such a source and its
journal. Live-session collapse checks before interruption as well as after close,
but the preflight is not a writer lock. This does not recover a source already
deleted, or make a return sweep usable.
A dormant capture helper now reads each conversation's active entries and
contributions from the already-open Pi Harness, preserving Pi's own head and
edit semantics, and checking bounds before and after capture. It rejects forks;
its caller must seal all writers, since the checks are not a lock and do not
cover inbox or task changes. A dormant conversion now reuses Carto's existing
archive-part logic on each captured context separately, pairs tool results only
within their conversation, and attaches versioned source generation,
conversation and entry provenance to each item. Archive storage and editing
retain it when explicitly written. Main restoration now refuses child or
malformed source provenance; legacy rows without it retain their old behavior
and cannot be distinguished from a row whose provenance was lost. The helper
rejects duplicate or missing call identities and multi-message entries rather
than guessing. Image-only user inputs are now prepared as one person-message
item with a display label and their original Pi content retained for restoration;
the archive editor does not turn that label into person-authored text. An active
checkpointed image-only input is excluded from the sweep and retained for replay.
Direct sweep is unchanged. A further dormant preparation
reuses Carto's Chat bindings to exclude only uniquely identified main person
messages whose text matches a Brain Chat record and whose content is text-only.
Child messages, attachments and ambiguous or legacy text matches remain; a latest
Carto Chat edit can identify an otherwise legacy entry. Return preparation also
includes Chat calls (without changing the direct sweep), retaining child calls
and results. It identifies only simple main calls whose exact call ID and text
match one agent Chat record; extra arguments, call metadata or ambiguous records
prevent deduplication. Full candidate parts remain available for subsequent
mark handling. A dormant planner now classifies pin, delete and Chat-duplicate
candidates and reuses the ordinary collapse deletion writes. It blocks child
pins from main, unproven pins, conflicting current main pins and image-bearing
pins. Older main pins need identities checked against the source snapshot;
deletions override pins. A dormant source-checkpoint inspection now resolves each
saved submission on Pi's transaction line against the returned handoff, owned
child, source barrier and captured view bounds. It also rescans the complete
conversation set in the transaction, refusing omitted conversations and ones
created after view capture. This does not authenticate supplied contributions
or lock the source. It checks placed entries and
active contributions without text-based identity guessing, and checks queued
content while Pi still retains it. An already withdrawn queued input is explicitly
reported as unverifiable against Pi because only the checkpoint retains its
content. It reports Pi status rather than assuming a completed submission means
the delegation was fully answered. A dormant reconciliation planner now combines
that inspection with the existing mark and Chat planner. It keeps all checkpointed
inputs for replay even when Pi says done, excludes active placed input entries
from prospective archive candidates by identity, and returns checked explicit
pending Chat identities for exclusion from the new head. An ambiguous or marked
Chat record or a pin/deletion mark on a checkpointed source entry blocks rather
than silently overriding the person's action. Withdrawn queued content remains
verifiable only against the checkpoint. The planner does not commit a sweep or
permit source deletion; callers must seal Pi and Brain writers and verify the
snapshot. An additional dormant planner composes that reconciliation with the
same file-pin and pinned-read refresh used by ordinary collapse, returning file
texts and prospective Brain writes. It retains existing missing-file and
delete-over-pin behavior without mutating the snapshot. Before refreshing a
pinned read, it compares the call ID, tool and exact path to the captured main
result or to the corresponding item supplied from the verified frozen head.
Unproven path aliases and transient F handles block rather than being resolved
from the current tree. The lower-level mark planner does not perform these
checks; the host must supply authentic frozen items and seal the sidecar, files
and settings as well as Pi and Brain writers. A separate dormant source-head
capture reads the generation's markdown and sidecar, compares the markdown to
Pi's replayed main `carto-context`, checks visible pin rows and sidecar structure,
and fingerprints both byte streams. A wrapper uses those captured items and Chat
IDs in prospective reconciliation. This does not authenticate hidden sidecar IDs,
Chat membership or pin call metadata: the projection does not contain them.
A digest can detect later changes but cannot establish initial authenticity or
seal writers. The prospective pin-refresh path now compares every retained frozen
item's kind, text, creation time and entity to the Brain, allowing repinning by
a different author. A frozen item removed from the Brain by unpinning remains
visible in the old head but is not part of the captured Pi body; the planner
blocks rather than lose it. An explicit deletion mark still wins. Archiving such
an item with enough original data for restoration remains unfinished. This is a
return-planning guard only, not a change to direct collapse. A future host must
independently establish provenance and recheck all captured state. A dormant
record planner now reuses ordinary collapse's record-mark preparation and
archive-restore logic, returning prospective writes, incoming records, the
resulting Brain and ephemeral restores requiring separate destinations. It
refuses archive identity collisions and record restores over existing records.
The composed planner now also prepares ordinary Atlas freshness writes before
record-mark preparation and renders the prospective head through Carto's
existing projection, excluding checkpointed Chat identities. For a reported
return it now plans the exact required main message as an agent Chat write in
the prospective sweep and projection, keyed by source generation and handoff;
identity conflicts in Brain or archived Chat block. Person-ended and failed
returns do not invent delegate speech. The existing Brain collapse transaction
can now optionally bind this Chat to the transfer and commit it with the sweep
and journal. It rejects a mismatched, duplicate, missing or conflicting write,
and committed recovery checks the retained Chat before cleanup. The binding is
not a source-deletion permit, and an orchestration host does not yet use it;
a failure notice and end-to-end report delivery still need integration. It leaves
the original Brain untouched for use as the expected commit snapshot. Freshness
for restored Atlas records follows ordinary collapse's existing ordering; these
filesystem observations are neither atomic nor locked. The Brain transaction
remains responsible for the real sweep, archive grace and pending restore
acknowledgement. Source authentication, sealed reads and atomic journal binding
remain open; this plan authorizes no deletion.
A dormant source seal now hashes the logical contents and schema of a
stopped Pi store in a single read-only SQLite snapshot, including committed WAL
changes, using fixed primary-key ordering and rejecting unknown tables, key
shapes, column types and schema versions. An optional, validated seal can be
retained atomically with the Brain's delegation transfer. Committed recovery
now compares an explicitly stored seal with any surviving source and preserves
both generations and journal if it changed or cannot be checked. A seal does
not weaken the multi-conversation guard; transfers without a seal keep their
existing recovery behavior. If cleanup already removed the source before a
crash, recovery cannot check it and continues the existing idempotent cleanup.
This is only a change detector and never permits source deletion by itself. A
dormant wrapper now captures a plan between two such source fingerprints,
compares the Pi handoff, checkpoint and barrier with stored revisions, and
rechecks projection and Brain/archive snapshots. Pi inspection rejects unfinished
tasks and queued or placed submissions before and after capture, including
background work and queued writes. It also reuses the existing unanswered-input
scan and checkpoint verification for main and the owned child; missing content
or a scan failure blocks capture. Before fingerprinting, the wrapper writes a
fresh challenge into a Pi source document and compares it with the named store
through a read-only SQLite connection. It also uses Pi's Storage document API
to check the same identity and challenge before and after the submission scan,
rejecting accidentally unrelated Harnesses or scan stores. Once written, the
challenge remains even if later capture fails. The host must still supply the
actual backing storage: copies, replacement, relays, a misleading scan or a
subsequent path swap are not excluded. The scan cannot reconstruct withdrawn
content. These are point-in-time checks, not a pause or writer lock. The wrapper returns its values together but does not journal them or
protect against ABA changes and filesystem races. The host must ensure the
backing-store relationship and seal writers; a SQLite read snapshot is not a
lock. The captured projection digest can optionally be retained with a source
seal in the transferred handoff and Brain journal; committed recovery refuses
cleanup if either source projection file is missing or its bytes changed while
the source store remains. Cleanup already begun without the source is still
idempotent. This detects later changes, not initial sidecar authenticity, and
is not used by a host or a permit to bypass the multi-conversation guard. Hidden
sidecar authentication and full sweep/journal integration remain necessary. The
actual return path does not archive the prepared items or
remove the return guard. A dormant child-restore helper can place a committed
pending item into an ownerless passive Pi conversation, using a persistent map
and source marker to reuse the same destination on retry. It verifies the Pi
entries and derived contributions, then compares the archive snapshot before
acknowledging. A composed destination helper places pending main and child
restores before checkpoint staging and return admission, blocking if restoration
fails or a pending restore appears after staging. Retries reuse previously
placed Pi entries; this requires the host to install its barrier and seal all
destination and archive writers. It cannot resume the original task or run on
startup. Its added conversation remains protected by the ordinary collapse
guard. Host routing and end-to-end crash-safe recovery remain unfinished.
The submission scan guards immediate-end and restart-recovery aborts, normal
return checkpointing, and the prospective capture wrapper. Lower-level checkpoint
and planning helpers do not perform it; it does not reconstruct withdrawn
content or provide a resolution workflow. Multi-conversation source deletion
remains guarded.

## Decisions recorded during refinement

The person asked that answers be recorded and committed as the discussion
continues, rather than left only in conversation. These decisions refine earlier
proposal text; unresolved details are not implicitly decided by them.

- **Specification lives in the project.** The maintained project specification
  is kept in project files alongside the code, not solely in the Brain, so it
  can be versioned and shared and survives a Brain wipe. The Brain may hold
  working context and cached evidence; externally changed project files must be
  reassessed rather than trusting stale cached understanding. Do not silently
  create a second authority when an existing specification is present. Exact
  file layout remains to be decided.
- **Structured specification takes over.** When an existing specification is
  captured into the structured specification and the transition is agreed, the
  structured specification becomes the specification of record. During an
  incremental transition, the structured specification takes over each captured
  part, while the old specification remains authoritative for parts not yet
  captured. Keep a mapping in project files linking old specification sections
  to their structured replacements so the authority boundary is visible, without
  editing the old specification. If Carto finds an external edit to an old
  section that has already transferred, it flags the edit and asks the person
  what to do rather than silently applying or ignoring it. Discrepancies still
  require discussion before being written into the structured specification.
  This decision does not itself transition Carto's `SPEC.md`.
- **Separate authorship and work.** Main writes or updates the specification,
  then delegates implementation to a different context. When the person's
  request is clear, main updates the specification and delegates immediately,
  without a general spec-diff approval stop. The separate confirmation rule for
  replacing existing behavior below applies. A worker that finds a spec gap
  reports it back to main rather than editing the specification itself.
- **Capture existing projects incrementally and deeply.** Capture the behavior
  relevant to work as Carto encounters it, rather than requiring a whole-project
  capture before work starts. Trace the depth of that behavior and where a change
  may affect other aspects of the code, including callers, dependencies, shared
  state, side effects and tests. Capture reports evidence and unknowns; it does
  not claim a complete impact map. It does not justify rewriting existing code.
- **Existing specification-like material.** If Carto encounters anything
  resembling a specification, it asks the person what to do with it and
  recommends capturing it with higher priority than the code. Discrepancies
  are discussed with the person before they are written into the maintained
  specification. Finding such material does not by itself establish that its
  requirements were dictated or accepted by the person. When the person agrees
  to capture an existing specification, its undisputed requirements count as
  accepted as a whole, not dictated; discrepancies still must be discussed
  before they are written into the maintained specification.
- **Capture is a distinct delegate.** Main delegates capture to a focused,
  bespoke context, separate from implementation and verification, with limited
  tools. It receives the request, relevant specification and starting points,
  may follow connections to investigate, and returns findings with sources to
  main. It does not write the specification. Read/search rather than edit tools
  are the proposed starting point; the exact tool set and how limitations work
  need design. An unrestricted shell can write, so hiding editing tools is not
  by itself write isolation. All delegates run sequentially on the one model.
- **Reuse and idle capture.** Main can reuse relevant capture findings when
  they remain current; it delegates fresh capture when the affected area is
  unclear or the code or surrounding dependencies change. When not given an
  active task, main should seek to capture the project systematically, in
  focused delegated slices. On reopening with no active task, follow Carto's
  existing startup, resume and sleep behavior rather than starting capture just
  because orchestration mode was restored. For example, an indefinite sleep
  remains stopped until a message or resume, while a timed sleep remains durable
  across restart and can wake on its timer. Once main is running without an active
  task, it should seek systematic capture. Existing unknown intent remains
  unknown; capture alone does not authorize implementation changes except for
  the agreed correction of conflicts with accepted or dictated specification
  described below.
- **Idle capture finds a spec conflict.** If idle capture finds code conflicting
  with an accepted or dictated specification, Carto fixes it without waiting for
  the person to request the fix. After the implementation delegate reports,
  main raises the conflict and outcome with the person. Assess the conflict
  rather than assuming a capture finding is proof. This authorization concerns
  correcting that conflict; unrelated incidental behavior changes still follow
  the confirmation rule below.
- **Verification is chosen by main.** Main decides when a separate verification
  context is needed; it need not run after every implementation task, so several
  changes can proceed before verification. Results must distinguish checks
  actually performed from work not verified. The exact selection and checks
  remain to be designed.
- **Delegation controls.** Capture is an ordinary delegated task, not a special
  background process. The person may interrupt any delegation at any time or
  call for early return. The normal agent's controls apply to an active delegate:
  `SPEC.md` §9 defines steer, follow-up, interrupt, pause and cancel, including
  partial in-flight tool results. Do not invent an automatic interruption on a
  normal message. The person can steer the delegate to report if desired, or
  use a command to end the delegation immediately; the UI prompts for a reason,
  which may be blank. Immediate end does not give the delegate an extra reporting
  turn. The person's reason, including a blank reason, goes in the report field,
  and main is informed that the person ended the task early. The reason is the
  person's input, not a delegate-generated account of work or completion.
  Preserve partial work and do not invent a delegate report.
- **Behavior provenance and promotion.** Keep these distinctions:
  - **Dictated:** a feature, build, or implementation requested by the person,
    or behavior promoted to dictated.
  - **Accepted:** behavior found in capture and explicitly accepted by the
    person, including undisputed requirements covered by the person's approval
    to capture an existing specification; acceptance does not mean the person
    dictated it.
  - **Observed:** behavior found by the agent that the person has not accepted,
    including behavior the person decides is fine to keep unpromoted.
  - Observed behavior can be promoted to accepted or dictated; accepted behavior
    can be promoted to dictated. A lack of objection is not acceptance, and
    acceptance alone is not dictation. How these statuses are represented in
    the chosen standard and the mechanics of promotion remain open.
- **Replacing existing behavior.** When a requested feature would change an
  observed behavior, main flags the consequence and asks the person before
  changing it. The person extended this to replacement of accepted or dictated
  behavior: the agent distinguishes which status applies and asks the person to
  confirm the change. This is not automatic promotion or acceptance of observed
  behavior. An unambiguous explicit request to replace the identified behavior
  with a specific alternative counts as approval; no redundant separate
  confirmation is needed. Incidental changes not covered by that request still
  need to be flagged and confirmed.
- **Unexpected behavior change during implementation.** If a delegate discovers
  that completing its task would change behavior the person did not request, it
  returns a blocked report to main rather than asking the person directly. Main
  explains the affected behavior and its status, asks the person, updates the
  specification if needed, and delegates the next step. Work already done
  remains in the project. The person retains the normal ability to steer or
  interrupt a delegate.
- **Context-limit return.** When a delegate approaches its context limit, Carto
  forces a return to main rather than collapsing the delegate's context to
  continue. Trigger this before the limit and reserve room for a required report
  of work done, remaining work and uncertainty. Main reassesses and may delegate
  another focused task. A report cannot be guaranteed if, for example, an
  unexpected overflow prevents it: preserve partial work and tell main the
  report is missing rather than inventing one. The threshold, reserve and
  enforcement mechanism remain to be designed and tested.
- **Jobs outlive delegate return.** A background job started by a delegate keeps
  running when the delegate returns, so main can manage it; Carto does not stop
  it merely because the task ended. Job ownership and handoff mechanics still
  need design, including making the job and its status available to main.
- **Mode default and startup.** Direct mode is the default. Carto remembers the
  selected mode separately for each project and restores that project's mode on
  startup rather than resetting to direct mode each time.
- **Mode switch while a delegate is active.** When the person requests a switch
  from orchestration to direct mode during an active delegation, show a warning
  with yes/no choices, operable by click or keyboard; the keyboard defaults to
  no. Yes ends the delegate immediately and switches to direct mode; no cancels
  the switch. The existing rules for a person-ended task apply: no final delegate
  reporting turn, optional person-authored reason, preserved partial work and
  surviving background jobs.

## 1. Recommendation in one sentence

**Use genuine ***plain as the first candidate for the durable project contract;
build Carto's own sequential assessment and handoff around a proven existing
parser, and repair the smallest justified behavior only after assessing the
current code against that contract.**

This is a recommendation to evaluate and adopt an existing format and parser
when the feasibility gate passes, not a claim that they already work in Carto.
In particular, **the ***plain components examined below disagree about syntax and
test files**: version the language profile and validate the actual selected
implementations before calling the format interoperable. It is not a proposal
to install plain-forge, run Pyro, embed Turri's whole harness, adopt their
generated-folder layout, or invent a new language in advance. If ***plain cannot
meet a required property, report the specific incompatibility and compare
alternatives with the person before choosing a fallback.

## 2. What the source review found

This proposal examined Turri at commit `7ada23456908792bdba5d9b0651df84975793df9`
and the reference parser at `e3dbd27df6e833c1330c31392d87de61b1d8b402`. The
repositories are references, not new Carto dependencies. Important findings:

1. **A real format and parser exist.** Turri's `src/plain/` parses modules,
   concepts, import/require chains, linked resources and test scenario files.
   Its published `@turri-dev/cli/host` entry actually exports
   `plainFileParser`, `checkPlainFile`, `iterateFunctionalSpecs` and
   `plainGraph`; the graph links modules, concepts, resources and scenarios.
   `plainGraph` item IDs are file-and-line positions, so they are not durable
   behavior identities; use module plus `func-id` for those. The upstream
   `plain-parser` is a Python package/CLI, `parse` emits versioned JSON, and it
   has a Python runtime requirement. Turri's parser is a TypeScript port; its
   parser notes say its tracked reference revision and conformance comparison
   need attention. Neither path is a drop-in decision without checking the
   published versions and their actual behavior.
2. **Turri's drift is spec-to-record, not a proof about code.**
   `src/regenerate/drift.ts` compares a recorded spec tree with today's tree;
   `records.ts` keeps separate code and conformance-test records and hashes
   linked resources. `spec-steps.ts` compares stable items, while `casesOf`
   tracks added, changed, removed and explicitly regenerated functions and
   follows changed concepts. A matching record says what code was recorded as
   built from, not that nobody edited the code or that it satisfies every rule.
3. **Turri uses targeted changes, not only whole rewrites.** A changed spec is
   normally a patch case; an explicit regenerate-again case builds that
   functionality anew. Test scenarios have their own identities and changes.
   Turri recomputes work after a job or spec change. Its selected response to a
   stale job includes stopping and rollback: Carto cannot import that behavior
   into a real, shared working tree without changing the earlier decision.
4. **Checks and independent test roles are useful, but not proof.** Turri's
   `unit-gate.ts` runs the project's test script itself; conformance work has
   separately described scenarios and roles. Its parser can check shape and
   links, not whether a requirement in the wrong section was understood or
   whether a scenario is complete. No test scenarios means no scenario-based
   conformance coverage for that functionality, not evidence that it conforms.
5. **Capture is instructive, not a migration guarantee.** `src/capture/`
   maps an existing project, surveys it, identifies interfaces, writes
   proposed specs and scenarios, and can try scenarios against a copy of the
   original. It reports unknowns and omissions. Its documented workflow is to
   work on the captured definition and abandon the original; Carto instead
   needs to preserve and assess the existing project in place. Capture can
   describe existing behavior, including bugs: it cannot decide intent.
6. **Turri's isolation is not Carto's.** Turri's role-specific workspaces,
   command checks, optional OS sandbox and audit support its independent
   testing and rollback model. Carto's `bash` is trusted and is not a sandbox,
   and the task works on the real project. We must not claim tool separation,
   independent tests, write isolation or automatic rollback merely because a
   task is given a role.
7. **Turri has different runtime and concurrency choices.** Its package uses
   `pi-coding-agent` and LangGraph; capture and other work can use parallel
   agents. Carto uses pi-durable conversations and its own Brain, collapse and
   UI. Reuse an available parser if suitable, not a second agent runtime or
   scheduler alongside pi-durable. Every model-inference path must serialize
   across main, task, review and any capture work, including recovery.

Source entry points: [Turri parser](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/plain/index.ts),
[host exports](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/host.ts),
[drift](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/regenerate/drift.ts),
[records](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/regenerate/records.ts),
[work loop](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/regenerate/loop.ts),
[capture](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/capture/capture.ts),
and [reference parser](https://github.com/plainlang/plain-parser/tree/e3dbd27df6e833c1330c31392d87de61b1d8b402).

### Additional review: the upstream regenerative-software stack

The [entry repository](https://github.com/plainlang/regenerative-software/tree/d35b03fcc68c5ee2609b76ee7b9edeb9e09439ec)
is an overview and license, not an implementation of an orchestration engine.
Its linked stack was reviewed at plain-forge `c981a7a37a9f038448263fc59ee571a42b88d3b3`,
Pyro `c8e6efaadfde06cf6ea36866529f416a7e548abe`, upstream parser
`e3dbd27df6e833c1330c31392d87de61b1d8b402`, plainlang-docs
`aa5891bd5a86ca6a9f8e250082be92d3e4fdd9d9`, plain-language-server
`edf0220d2f875bef91d487bfb1951ea2a261bf44`, tree-sitter-plain
`0c18b48f98d0ae5def55f0c9baaab317ccad7471`, and plyn
`f9c02b8d13029656a3296380027901623ab94b49`. These are inspected source
snapshots, not a tested or pinned release set. The examples repository was
also inspected at [`c2ddfd790b3abd878ea4d75d5a036fee5b2605d0`](https://github.com/plainlang/plainlang-examples/tree/c2ddfd790b3abd878ea4d75d5a036fee5b2605d0);
its Python hello-world test file has the 0.4 two-section form with an empty
acceptance section. Forge's checked-out submodule points at the Pyro snapshot
above; the npm wrapper's published `1.0.0` metadata instead pins forge `1.0.23`,
whereas the inspected forge checkout identifies itself as `1.0.19`. Findings
that revise the recommendation:

- **The installer is not a Carto integration.** The entry README points to
  plain-forge, Pyro and plain-parser. The npm entry package's registry metadata
  describes a wrapper forwarding to a pinned plain-forge release. Forge's
  installer copies skills/rules/docs into supported agents' directories and by
  default installs or upgrades Python tooling via `uv`; it does not list Carto.
  Carto has no demonstrated compatible skill loader. Do not run that installer,
  download runtimes, overwrite user skill files or claim drop-in support as part
  of this proposal. Inspect the exact published artifact when choosing a
  version: a repository checkout and an npm wrapper need not be the same release.
- **Forge provides valuable authoring patterns, not an executable contract.**
  Its `load-plain-reference` routes only relevant rules; `forge-plain` and
  `add-feature` ask focused questions, write and review snippets, and check
  conflicts and section ownership; `plain-healthcheck` combines parser checks,
  config/script inspection and agent review. These are skill instructions for
  supported hosts, not evidence of deterministic validation or a Carto API.
  Adapt the ideas to the person's chosen interaction policy and small contexts;
  do not import the mandatory one-question/approval loop or agent spawning
  wholesale. `debug-specs` directs every fix back to the spec, even when a clear
  spec's implementation is simply wrong; Carto must retain the distinct
  implementation-defect outcome in §5.
- **Pyro is a sequential agent skill, not a stand-alone deterministic compiler.**
  Its `render-spec` tells one agent to read the module/requirements/scenarios,
  implement and verify them, and report missing scenario coverage. It forbids
  subagents, which fits the single-inference constraint in that respect. But it
  implements into `plain_module/code`, writes tests to `plain_module/tests`,
  and copies output into `dist`; its `copy_folder.py` merges and overwrites
  matching destination files. Its scenario helper scans a `tests` folder next
  to the module rather than consulting the reference parser's configured test
  folders. Running it directly on an existing Carto project would not implement
  the agreed in-place, selective assessment-first workflow and could overwrite
  output. Its helpers are not a replacement for the reference parser. Treat
  Pyro as a reference unless a separately agreed integration proves otherwise.
- **The version mismatch is concrete, not theoretical.** The entry README's
  example shows 0.3 functional-spec bullets and nested acceptance tests. The
  reviewed plainlang-docs migration guide and reference parser describe 0.4:
  `# func-id` behaviors and separate test plain files with `module` and
  `func_id`. The reference parser's test file requires both conformance and
  acceptance section markers, allowing empty sections; Turri's reviewed port
  instead allows either section and rejects a present empty section. The
  `plain-language-server` source still diagnoses standalone acceptance sections
  as invalid and doesn't list conformance test sections; its Tree-sitter grammar
  likewise describes the old nested shape. Thus an apparently valid 0.4 project
  can receive contradictory editor diagnostics or parser failures. Do not use
  the landing-page example as a 0.4 fixture or promise plyn compatibility.
  Check actual released versions, not just these snapshots, before any adoption.
- **One format does not imply one workflow.** The upstream stack's stated model
  is spec-first and treats generated code as read-only; Turri's own `package.json`
  shows a separate pi-coding-agent/LangGraph runtime and no dependency on the
  upstream installer or Pyro. Both use ***plain ideas, but the available sources
  do not establish that the stack is a drop-in backend for Turri or Carto.
  Carto's person-directed selective in-place repair intentionally differs from
  the upstream renderer's generated-code workflow. It can still use a genuine
  ***plain format if the selected parser and compatibility profile pass.

Upstream source: [forge rule loader](https://github.com/plainlang/plain-forge/blob/c981a7a37a9f038448263fc59ee571a42b88d3b3/forge/skills/load-plain-reference/SKILL.md),
[forge healthcheck](https://github.com/plainlang/plain-forge/blob/c981a7a37a9f038448263fc59ee571a42b88d3b3/forge/skills/plain-healthcheck/SKILL.md),
[Pyro renderer](https://github.com/plainlang/pyro/blob/c8e6efaadfde06cf6ea36866529f416a7e548abe/skills/render-spec/SKILL.md),
[Pyro copy helper](https://github.com/plainlang/pyro/blob/c8e6efaadfde06cf6ea36866529f416a7e548abe/skills/render-spec/scripts/copy_folder.py),
[0.4 migration guide](https://github.com/plainlang/plainlang-docs/blob/aa5891bd5a86ca6a9f8e250082be92d3e4fdd9d9/docs/guardrails/migrating-from-0-3.md),
[reference test-file parser](https://github.com/plainlang/plain-parser/blob/e3dbd27df6e833c1330c31392d87de61b1d8b402/src/plain_parser/test_plain_file.py),
[Turri test-file parser](https://github.com/turri-oss/turri/blob/7ada23456908792bdba5d9b0651df84975793df9/src/plain/test-plain-file.ts),
[editor diagnostics](https://github.com/plainlang/plain-language-server/blob/edf0220d2f875bef91d487bfb1951ea2a261bf44/src/diagnostics.ts),
and [Tree-sitter grammar](https://github.com/plainlang/tree-sitter-plain/blob/0c18b48f98d0ae5def55f0c9baaab317ccad7471/grammar.js).

## 3. Project contract and authority

The project contract is a version-controlled, human-readable collection of
***plain modules and associated scenarios/resources in the project, not inside
`.brain`. Its exact location is a project choice. A behavior has a stable
`module:func-id`; a scenario has its module, behavior and scenario ID. IDs are
not Carto's generation-local display handles. Definitions, implementation and
test requirements, imports and linked resources are included as the parser
resolves them. Under the reviewed 0.4 rules, a func-id is unique within its
module and remains stable as the behavior's text changes; a scenario-id is
unique across all test files bound to that behavior, regardless of test section.
A test file's path is a convention, while its frontmatter gives the binding.
Do not treat Turri's graph file-and-line IDs as durable identities. A module or
func-id rename/move, deletion, split or reuse changes or threatens identity:
require explicit mapping when continuity is established, otherwise invalidate
old evidence and treat it as a removal/addition rather than guessing. Files are
still project files: existing strict/relaxed path and read-only semantics apply.

The project definition records the person's decisions and can also record
captured behavior as observed, clearly distinguished from accepted or dictated
behavior as described in the recorded decisions. Code, tests, notes and task
reports can provide evidence of current behavior, but do not independently
establish intended behavior or the person's acceptance. The person's current
instruction outranks the contract; a contradiction is surfaced and resolved,
not silently settled in favor of a stale document. An agent should ask when a
consequential ambiguity needs the person's decision; a draft assumption must be
marked as such. Clear requests do not require a general spec-diff approval stop
before main delegates work; replacement of existing behavior has the separate
confirmation rule above. This proposal does not add an approval queue to direct
Carto.

There must be **one authority per behavior**. For a project already using
`SPEC.md`, including Carto itself, no automatic migration or duplicate authoritative
copy is assumed. A bounded pilot can compare an explicitly labeled draft `.plain`
with the current spec; the current spec remains authoritative until the person
chooses a transition. On transition, determine which text is authoritative and
what becomes explanatory or is removed, including cross-cutting rules and linked
resources. `AGENTS.md` remains process guidance, not a substitute for the
project's behavior contract. No speculative rewriting of Carto's `SPEC.md` is
part of this proposal.

Atlas remains a loose, mutable attention/plan graph; Ledger remains active
working state; Chat remains conversation. They may reference stable behavior
IDs and evidence, but are not a second specification or a permanent build
history. A task receives a selected contract slice and selected context: main
pins need not change. Whole-project rules, dependencies and shared definitions
must accompany a slice when relevant; a narrow task must not receive a
misleadingly incomplete contract.

## 4. Parser and format feasibility gate

Before selecting a dependency or proposing a fallback, evaluate on a small,
read-only pilot containing a Carto behavior with cross-cutting constraints,
linked resources and scenarios. Compare:

- the published Turri host APIs (including parser/check/graph) and their actual
  package/version and dependency footprint against Carto's Node and pi versions;
- the reference Python parser's `check`/version-2 JSON `parse` CLI and Python
  3.11+ requirement, including exit/error behavior and compatibility with
  Turri's dialect; Pyro's helper scripts need Python 3.8+ but are not this parser;
- an explicit selected language/tool profile and fixture matrix: 0.3 vs 0.4,
  both empty and populated test sections, absent scenario files, multiple test
  folders/config defaults, bound and orphaned tests, duplicate semantic IDs,
  version migrations, modules, imports and linked resources. Include the
  examples' empty acceptance section and compare reference and Turri results;
  Turri's parser comparison document says its own cross-parser run was not done.
  Keep editor diagnostics optional or disabled for an incompatible profile,
  never as the validation gate; do not assume plyn integrates with Carto's TUI;
- if evaluating Forge skills or Pyro helpers, check the exact release artifact,
  license, discovery and loading, tool invocation and prompt budget, network and
  installation side effects, output paths and overwrite behavior, and whether
  adaptation preserves one-model operation and selective existing-code repair;
  execute any renderer pilot only with explicit approval in a disposable project;
- whether the available parser validates the chosen syntax, test bindings,
  imports, cycles, resources, error locations and malformed files; whether the
  needed graph and stable semantic IDs can be obtained without private APIs;
- MIT licensing and attribution obligations if code is reused or adapted, and
  maintenance/version-pinning cost; favor an existing supported public API over
  copying a parser or building a new one;
- source-text and reference-version compatibility, including Liquid template
  expansion, path/symlink boundaries and deterministic parsing; diagnostics
  must not cause Carto to treat an incomplete parse as a complete contract;
- the ability to preserve Carto's requirements, architecture constraints and
  externally visible edge cases without silently dropping rules.

A parser's declared compatibility is not proof: use a shared fixture corpus,
including current reference cases, and record exact versions and known
mismatches. A structurally valid result is not a semantic approval. If none of
the supported paths works acceptably, return a concrete incompatibility report
and a proposed alternative; do not claim a custom dialect is ***plain or
silently implement a new parser. Do not add Turri's stdlib defaults or full
harness simply to parse a project's contract.

## 5. Assessment before regeneration

The unit of attention is a behavior and its dependencies, not a whole project.
A spec change, linked-resource change, externally edited code/test/config, a
failed check, an explicit request, or a missing contract can make assessment
appropriate. Discovery is a signal: it does not itself say code is wrong, and
lack of a detected change does not prove it right.

For each candidate, main selects a focused assessment task. It reads the
relevant contract and current implementation/tests and returns findings with
sources and uncertainty. Proposed outcomes:

| Finding | Next action |
| --- | --- |
| Current implementation has adequate evidence for the current contract | Keep the code; record what was checked and its limits. A spec wording or scenario change alone does not require a rewrite. |
| Contract is ambiguous, missing or conflicts with the person's intent | Describe the gap and current behavior; resolve the contract first where a decision is needed. Do not generate a replacement from a guess. |
| New behavior has no implementation | Specify the behavior and its relevant cases, then implement the smallest coherent change. |
| Code is demonstrably inconsistent with the contract | Repair the affected behavior with the minimum justified change; retain unrelated code and behavior. |
| Test, setup, dependency or environment is wrong, missing or unavailable | Report which is observed, what is uncertain, and what can be done. A broken check is not proof the product is broken. |
| Insufficient evidence or incomplete impact map | Mark unverified/unknown; inspect further or ask, not report conformance. |

When an implementation change is needed, "regeneration" means bringing the
selected behavior into conformance using the existing code and the smallest
sensible change, which can be a patch. A rewrite of a component or a
from-scratch build is a separate, explicit choice, not a consequence of a
changed spec or a broad inferred dependency. Removing behavior is a product
change, not permission to delete shared helpers or unrelated tests. Assess
callers, shared invariants and side effects; expand the affected set when
warranted, or say what could not be assessed. Preserve unrelated code and
existing tests unless the specification or the person requires a change.

Contract-only clarification that describes current behavior can finish without
code changes. Conversely, unchanged contract text does not ensure unchanged
code conforms. Existing passing tests are evidence for what they exercise;
absence of tests, a passing command with unknown coverage, and a model's review
are not proof of general conformance. Comparisons, hashes, dependency graphs
and model judgments help select and explain work, but none proves semantic
equivalence or complete impact.

## 6. Evidence and drift

Propose a rebuildable assessment index under `.brain` (not in the model's
context by default) and retain the human-owned contract in project files. Each
assessment records, for the behavior IDs it actually examined:

- contract revision/content digests for the selected behavior, resolved
  definitions, requirements, scenarios and linked resources, plus parser and
  schema version;
- the specific code, tests, configuration and other inputs examined, their
  content fingerprints where available, and whether the dependency set is known
  incomplete; do not assume Git alone captures untracked or dirty work;
- checks actually run, commands/tool versions and relevant environment, time,
  result and scope, with readable evidence or a reference to it; distinguish
  a test failure, skipped test, missing tool, interruption and timeout;
- findings and assumptions, reported implementation and test changes, and
  unresolved questions; label an agent's claim separately from observed
  results.

State terms should distinguish **assessment/evidence current for the inputs
actually checked**, **assessment stale**, **failed**, **not assessed** and
**incomplete**. "Current" is scoped evidence, not a guarantee of conformance.
At assessment and before relying on a result or applying a proposed change,
recheck the relevant inputs; invalidate the evidence on a known change, and
mark it unknown if a path, dependency, environment or external effect cannot be
checked. Filesystem watches or mtimes can prompt a recheck but are not the sole
correctness test. Changes through shell, external editors, symlinks, Git or
another process may escape a tool hook; neither the state block's session write
list nor tree staleness is an exhaustive change log. If a result races a change,
keep the actual work and re-assess; never mark it current against a different
snapshot.

The `.brain` index is disposable with `/wipe` and rebuildable from current
project inputs and checks; losing it means **unknown**, not conforming. Whether
and how to keep portable, version-controlled evidence across machines is a
separate decision, not silently added to the contract or archive. Avoid storing
secrets or assuming command output is safe to keep; identify environment inputs
without recording credentials.

## 7. Proposed orchestration lifecycle

All steps here are orchestration-mode proposals, not changes to direct mode.
The main agent maintains the map and user conversation; the runtime carries
handoffs, not the model's private claims of success. One inference admission
point/lease covers all roles, not merely one task UI: no second active model
request while another is running, including wakeups, interruption and restart.
Shell jobs are not model agents. Delegate-started background jobs remain
running across task return, as decided above; their ownership and handoff need
design. Model changes, if used, are sequential swaps on the same hardware; no
special models are required by this design.

1. **Understand, capture and define.** Main reads the project contract if one
   exists, distinguishes the person's request, current behavior, gaps and
   intended changes, and keeps active planning in Atlas/Ledger. It delegates
   capture when needed, including systematic capture when there is no active
   task, and writes the definition itself from the findings and the person's
   decisions. Observed behavior remains distinct from accepted or dictated
   behavior. With a clear request, main updates the spec and delegates work
   without a general spec-diff approval stop, subject to the separate rule for
   replacing existing behavior. It does not replace or regenerate the project
   merely to adopt a format.
2. **Identify candidates.** Use parsed behavior IDs, resolved definitions and
   resources, recorded fingerprints, and relevant project changes to find
   potential impacts. The main agent also reads beyond the graph when useful;
   missing dependencies remain unknown, not absent. Classify assessment work
   before deciding code changes. No automatic global rewrite.
3. **Delegate one focused task.** Freeze a task input: instruction and
   done-when; behavior IDs and exact contract/resource revision; selected
   entries of any eligible main context kind; the relevant cross-cutting rules,
   existing evidence, and current project state or references as agreed. Main
   is suspended. The task has its own context and work tools, local pins and
   controls, and access to shared Atlas/Ledger as specified. Task context is
   isolated, but project and shared Brain writes are real and immediately
   visible; it is not a filesystem sandbox.
4. **Capture, assess or make the smallest justified change.** Capture, code
   work and verification use separate contexts; main owns specification
   authorship. Assessment or test work may also be delegated as appropriate.
   Roles are sequential context switches, not concurrent agents. A test/review
   task may offer a fresh perspective, but shared filesystem access and a shared
   model do not guarantee independence. Tool limits for capture need design;
   no filesystem isolation is implied by a role.
5. **Report at done or warning.** At done-when, return a structured report and
   the person's required main Chat message. At the existing warning, give the
   task a turn for Atlas/Ledger bookkeeping, then request its forced report.
   The report includes target IDs/revisions; findings and decisions; actual
   changes or explicitly none; checks and outcomes or explicitly not run;
   gaps/assumptions; remaining work; and done/partial/blocked/unverified
   status. The required message is distinct from task-local Chat. Grammar
   enforcement remains a feasibility gate (§9), not a promise. A person-commanded
   immediate end is different: it does not wait for a final reporting turn.
6. **Return and reconcile.** On ordinary report return, persist the report and
   deliver the required main Chat message exactly once, then perform a full main
   collapse: normal sweep, pending marks, pin refresh and archive grace. Resume
   main with the report and current Brain; main checks project/spec changes and
   evidence, resolves questions and updates Atlas/Ledger before delegating
   again. An immediate end also returns through the normal main collapse, but
   without demanding a delegate report or fabricating a delegate message. The
   person's optional reason goes into the report field and main is told that the
   person ended the task early. Keep its person-authored provenance clear; do not
   treat the reason as a delegate's findings. Do not transfer task-local
   conversation into main. A stale input/report is labeled and re-assessed; it
   cannot certify the changed contract.
7. **Failures remain real.** On overflow, a system message tells main to
   investigate and stitch a continuation; no fabricated report or success.
   Interruption, provider failure, unavailable grammar or failed collapse must
   preserve partial project and Brain changes, reports/drafts that exist, and
   the recovery state. Do not reset a working tree, discard an external edit,
   force a successful report or repeat a non-idempotent side effect to recover.

Durable orchestration needs explicit identities and phases for prepare,
running, report/failure, return Chat, main collapse, resume and cleanup. A
journal/commit protocol must distinguish durable data from filesystem and
external side effects across crashes. Pi's durable conversation and task APIs
provide admissions, transactions, ownership, replay policies and watches; they
are not automatic exactly-once filesystem operations or a one-model global
scheduler. Investigate reuse with Carto's existing collapse journal rather than
creating a competing collapse. A recovery with ambiguous state must preserve
what remains and report it.

## 8. Verification approach

Use the project's existing test commands and tests first. Scenarios can name
observable expectations tied to the contract; choose meaningful cases, not a
count or an assumption that a scenario exists for every behavior. A separate
sequential review can compare contract, tests, implementation and the task's
report; it can ask for further work but cannot establish truth by itself.

A failing check is diagnosed against evidence: implementation, test, contract,
environment or check setup may be responsible. Do not silently weaken, delete
or regenerate a test to make code pass. Tests may legitimately change when the
person changes the expected contract or when a test is actually wrong; identify
why, preserve unrelated assertions and report the change. A reviewer or test
role working in the same trusted project can modify files through `bash`, so
only claim isolation if a real enforcement mechanism is separately designed
and agreed. Automatic formatters, linting and new sandbox policies are not part
of this proposal.

Suggested end-to-end example: a changed wording clarifies that `/wipe` keeps
Carto open. The assessment reads the current behavior and tests, checks the
contract's resolved inputs, and runs appropriate tests. If they already cover
and demonstrate that behavior, Carto records the limited evidence and changes
no source code. If it finds the process exits, it reports the mismatch, then
delegates the smallest repair and relevant verification. If the tests cannot
run, it reports unverified rather than calling the code conforming or rewriting
it just in case.

## 9. Required decisions and feasibility checks

These are proposals/questions, not decisions attributed to the person:

1. **Contract adoption:** approve a small ***plain feasibility pilot first?
   The contract lives in project files, as decided above; settle its layout and
   how an existing `SPEC.md` is handled without two authorities. Should projects
   choose to use an existing other standard instead? What happens when the parser
   is missing?
2. **Decision policy and behavior status:** how are observed, accepted and
   dictated behavior represented in the chosen format, promoted and used when
   work may change existing behavior? When must main ask about an ambiguity,
   consequence or captured behavior? Clear requests proceed without a spec-diff
   approval stop as recorded above; preserve direct mode.
3. **Assessment scope:** when should assessment run—on request, after a
   detected change, or as part of an orchestration task—and what evidence is
   adequate to stop at "checked" rather than continue investigating?
4. **Mode lifecycle:** direct is the default and each project's selected mode is
   restored on startup, as decided above; other startup and switching details
   remain open. Mode is independent of edit/read-only and path scope.
5. **Task inputs and controls:** exact eligible selected entry types, snapshots
   vs references, shared Atlas/Ledger visibility, missing/stale references,
   message routing, pause, cancel, interruption, wipe, exit and task view.
6. **Task context and jobs:** context-limit return replaces local collapse as
   the continuation at the warning; other task-local boundaries, including
   Chat, pins and archive handling, still need design. Define shell/job
   ownership and the handoff of jobs that survive task return.
7. **Reports and grammar:** exact report/message schema and separation; verify
   GBNF enforcement and forced tool/report behavior on the actual installed
   pi-ai/llama-swap/llama.cpp route, including durable replay. Installed pi-ai
   types expose JSON-schema and OpenAI Lark/regex grammar variants, which alone
   do not establish native GBNF support. If unavailable, agree a failure policy
   rather than silently weakening the requirement. A valid grammar constrains
   form, not truth, and cannot guarantee a report after overflow or crash.
8. **Recovery and verification:** evidence retention and privacy, stale input
   handling, project changes made outside Carto, report/Chat/collapse atomicity,
   and what the person sees when a check or task fails. Real partial work must
   remain available; main return must not be duplicated.

## 10. Proposed implementation stages, after decisions

Each stage is a separately reviewed change; `SPEC.md` precedes behavior, and
Carto's full `npm test` budget and existing test policy remain in force. These
stages are not authorization to implement now.

1. **Format pilot and decision.** Read a bounded part of Carto's current spec;
   make an explicitly non-authoritative ***plain draft with scenarios and
   cross-cutting inputs. Evaluate real parser candidates, fidelity, errors,
   impact graph and costs. Compare against existing source/tests; document
   mismatches and get a format/authority decision. No source regeneration.
2. **Specify the agreed orchestration and contract boundaries.** Update
   `SPEC.md` for mode selection, authority, data placement, task handoff,
   return, failures, person controls, evidence and archive semantics after the
   decisions above. Resolve any tension with prompt-trusted direct mode, frozen
   head and actual deletion semantics.
3. **Read and assess the contract.** Integrate the chosen supported parser;
   surface parse errors and missing resources. Add semantic IDs, focused
   contract slices and a rebuildable evidence/index layer. Test malformed
   input, missing/unreadable resources, external changes and invalidation;
   neither loading nor a spec diff edits project source.
4. **Durable sequential task handoff.** Reuse pi-durable primitives, isolate
   task context and serialize all inference; keep direct mode intact. Test
   arbitrary selection, shared Brain/project effects, local pins, failure and
   restart without replaying side effects. Address report enforcement only
   after the grammar feasibility check.
5. **Assessment and selective repair.** Enable main to delegate a bounded
   assessment, capture gaps, use current code/tests, and decide whether any
   change is warranted. Support scoped implementation and verification
   handoffs, with evidence and uncertainty. A conforming implementation with a
   clarified spec must not be rewritten; a real mismatch gets a small repair.
   Do not infer a complete impact map or protect tests with a prompt alone.
6. **Return, collapse and UI.** Implement the required report/Chat delivery and
   full main collapse with crash recovery, local-task controls and archive
   access. Test normal, repeated, interrupted and overflow returns, preserved
   partial changes, evidence races, archive grace, pause and headless behavior.
7. **Existing-project adoption.** Only after the core works, offer bounded
   capture/transition with explicit omissions, source references and review of
   intent. Keep current source and tests; never automatically generate a
   replacement from an incomplete captured definition.

## 11. Acceptance criteria for an eventual approved design

- Direct Carto remains unchanged; orchestration is separately selected, with a
  single model inference at a time and visible, controllable task work.
- The chosen standard's real parser and compatibility are demonstrated; a
  project has one declared contract authority, not drifting duplicate specs.
- A conforming implementation is left alone; changed text triggers assessment,
  not assumed failure. Missing intent, new behavior, observed mismatch, failed
  checks and incomplete evidence are distinct outcomes.
- Focused tasks receive the relevant contract and selected context, use shared
  Atlas/Ledger and real project files, report evidence honestly, and preserve
  partial changes and the person's work on failure.
- Main return records the required message once and performs a normal full
  collapse; interruption, overflow and restart do not fabricate reports, replay
  destructive effects, duplicate a collapse, or lose recoverable state.
- Evidence is traceable to what was checked and becomes stale or unknown on a
  detected relevant change; no parser pass, fingerprint, model review or test
  pass is presented as proof of complete conformance.
