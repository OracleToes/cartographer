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
returns are close together. Task-local collapse and other unresolved boundaries
remain decisions, not assumptions.

## Decisions recorded during refinement

The person asked that answers be recorded and committed as the discussion
continues, rather than left only in conversation. These decisions refine earlier
proposal text; unresolved details are not implicitly decided by them.

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
  focused delegated slices. Existing unknown intent remains unknown; capture
  alone does not authorize implementation changes.
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
    person; acceptance does not mean the person dictated it.
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

**Next unanswered question:** how should Carto classify a requirement in an
existing project specification when it cannot establish whether the person
explicitly requested or accepted it?

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
Shell jobs are not model agents, but their ownership and persistence still need
a decision. Model changes, if used, are sequential swaps on the same hardware;
no special models are required by this design.

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
   Where should a project's contract live, and how is an existing `SPEC.md`
   transitioned without two authorities? Should projects choose to use an
   existing other standard instead? What happens when the parser is missing?
2. **Decision policy and behavior status:** how are observed, accepted and
   dictated behavior represented in the chosen format, promoted and used when
   work may change existing behavior? When must main ask about an ambiguity,
   consequence or captured behavior? Clear requests proceed without a spec-diff
   approval stop as recorded above; preserve direct mode.
3. **Assessment scope:** when should assessment run—on request, after a
   detected change, or as part of an orchestration task—and what evidence is
   adequate to stop at "checked" rather than continue investigating?
4. **Mode lifecycle:** defaults and switching, persistence, and switching during
   a task; independent of edit/read-only and path scope. Existing direct mode
   should remain the default for existing projects unless decided otherwise.
5. **Task inputs and controls:** exact eligible selected entry types, snapshots
   vs references, shared Atlas/Ledger visibility, missing/stale references,
   message routing, pause, cancel, interruption, wipe, exit and task view.
6. **Task-local collapse and jobs:** how local Chat, pins and shared archive
   interact across a local collapse; avoid accidentally advancing main archive
   grace. Define shell/job ownership and survival across task return.
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
