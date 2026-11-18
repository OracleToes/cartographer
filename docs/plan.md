# Cartographer delivery record

**Status:** C1–C5 complete.
**Date:** 2026-11-16
**Scope:** the delivered same-model consultation conference and its one-way legacy
cutover. This is a completion record, not authorization for another compatibility
layer.

## Delivered product boundary

Cartographer now has one consultation product: `consult` starts a bounded, isolated
conference on the caller's already resolved model. It captures its input at entry,
routes participant turns through a host-owned grammar-constrained selector, retains a
private `co<N>` audit record, and returns a structured advisory result to its caller.
It has no project, shell, network, shared-brain, plan, approval, user-decision, or
nested-task authority.

C1–C4 delivered the conference capability gate, immutable source/book capture,
independent Durable child, bounded participant/selector lifecycle, structured return,
recovery/cancellation handling, and on-demand private audit UI. The full design and
contract remain in [`consult-mode-proposal.md`](consult-mode-proposal.md).

## C5 cutover

C5 is a one-way archival migration, performed before Cartographer opens the session or
any retired runtime surface:

1. It inventories legacy storyteller bytes, legacy Case records, legacy storyteller
   shelf placements, and retired Case task metadata.
2. Any active, resumable, unreadable, or malformed Case record blocks startup. The
   user must start the pre-C5 release and explicitly stop unfinished work; C5 never
   bypasses or auto-retires it.
3. Terminal legacy records are copied byte-for-byte into `.brain/legacy/raw/`, with
   SHA-256 digests in `.brain/legacy/cutover-v1.json`. Readable static exports are
   written to `.brain/legacy/exports/` and can be regenerated from the retained raw
   bytes.
4. A legacy storyteller shelf placement becomes an immutable ordinary text snapshot.
   The pre-rewrite context bytes are also retained when such pointers or retired task
   metadata must be removed.
5. Only after archival and pointer retirement succeed are the live storyteller and
   Case stores removed. The runtime has no legacy story or Case parser, reader,
   renderer, tool, command, or recovery path.

The old `consult.thread` field is explicitly refused. The retired external-consult
settings (`consultModel`, token, temperature, timeout, and `CARTO_CONSULT_MODEL`) are
also explicit configuration errors; they are never ignored or used as a fallback.

## Non-work and retained boundaries

- No external consultation model, transcript continuation, or alternate `consult`
  meaning remains.
- No Case lifecycle, phase/witness workflow, Case-specific harness behavior, or Case
  UI remains.
- Archived material is static history only. It is not a conference source, a shelf
  resolver, or a compatibility database.
- Consultation remains separate from task staging, shell windows, and change
  authority.
- A future scratch-space or persona expansion needs its own design and proof; it is
  not implied by the conference notebook.

## Validation record

The delivered branch validates the cutover with:

- unit coverage for same-model-only consultation, retired input refusal, active and
  malformed legacy Case blocking, byte-exact archive/digest/export recovery, and
  inert shelf snapshots;
- CLI coverage for blocking an unfinished Case before startup, archiving stopped
  data, exposing no Case tool, and starting a same-model conference with no legacy
  writer;
- conference coverage for provider grammar enforcement, immutable capture, routing,
  recovery, cancellation, bounded request-plan audits, and structured returns; and
- source syntax checks and `git diff --check`.

`npm run test:ported` has two environment-only Bubblewrap skips when `bwrap` is not
installed; those confinement checks are unrelated to the consultation cutover.

## Documentation roles

| Document | Role |
| --- | --- |
| [`design.md`](design.md) | Durable product intent and settled decisions. |
| [`atlas-attention.md`](atlas-attention.md) | Verified Atlas-attention implementation record. |
| [`consult-mode-proposal.md`](consult-mode-proposal.md) | Delivered conference contract, isolation model, and acceptance rationale. |
| `plan.md` | This completed delivery and cutover record. |
| [`../README.md`](../README.md) | Current shipped behavior and migration-facing user guidance. |
