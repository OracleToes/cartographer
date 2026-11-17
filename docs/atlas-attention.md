# Atlas attention — heat, decay, and focus

**Status:** restored implementation record, 2026-11-16. Current attention mechanics are verified; the user-selected fresh-confirmation gate for permanent removal is an approved alignment slice, not yet runtime behavior.

The durable Atlas graph records project knowledge. Its attention data is a bounded,
derived work trail beside that graph. Attention never proves a node true or false,
changes a claim, archives anything automatically, or creates a node for an observed
path.

> Restoration note: no standalone Atlas-attention file survives in reachable Git
> history. The retained intent is `docs/design.md` §8; this focused record restores the
> feature documentation from that intent and the current implementation, rather than
> pretending to recover unavailable byte-for-byte prose.

## Model

Atlas lives in `.brain/carto-atlas.json`. It has two related but distinct surfaces:

- `nodes` are durable project-map claims, links, and file associations; and
- `attention` plus `view.focus` are derived operational state.

The persisted attention shape is bounded:

```js
{
  epoch: 0,
  nodes: { "c1": { epoch, at, kind, path?, label? } },
  gaps: { "src/unmapped.mjs": { epoch, at, kind, path, label? } }
}
```

On load, invalid entries are discarded, node entries must refer to known IDs, and gaps
are capped. Scores are not stored: each view derives them from the current epoch and
source records. This keeps recency advice separate from Atlas truth.

## Observation and decay

`observeAtlas()` owns the epoch and maps observed paths to existing active nodes. A
nonempty admitted observation batch advances the epoch once, even if that reply made
several successful reads or shelf operations. The harness publishes one batch only
when the response's calls have all completed. A declared task target is deliberately
not such a fact: it is a temporary **Active work** overlay until an actual observation
or checkpoint change supplies durable heat.

An observation can contain named node IDs, project paths, a bounded kind, and a label:

- a path covered by an active Atlas node refreshes that node's attention signal;
- a path with no active covering node becomes a **mapping gap**; and
- a later active node covering a gap resolves it without fabricating a new node.

Decay is measured in **work epochs**, not wall-clock time. The current policy values
are deliberately fixed rather than user controls:

| Policy | Value | Meaning |
| --- | ---: | --- |
| `hotEpochs` | 1 epoch | A directly observed signal remains hot while its age is at most one epoch. |
| `warmEpochs` | 6 epochs | An older direct signal remains warm through age six. |
| `candidateEpochs` | 12 epochs | A cold node may become advisory maintenance work after this many epochs. |
| `gaps` | 32 | Maximum persisted mapping gaps. |
| `listed` | 8 | Per rendered attention category. |
| `candidates` | 6 | Detailed cold candidates shown while idle. |

The renderer also marks the one-hop graph neighbours of a direct node as **Nearby**.
That propagation never recurses to a second hop. Recency, graph proximity, focus, and
active work may all give a node independently visible reasons to appear.

## Focus, active work, checking, and candidates

### Explicit focus

`book target=atlas action=focus` stores one durable focus on either an existing node or
a confined project path, with a short reason, author, and timestamp. A later `focus`
replaces it visibly; `unfocus` clears it. Node focus follows the stable Atlas ID through
a rename.

A running declared move is different: `activeMoveOverlays()` derives a temporary target
overlay from that move's exact paths. It never writes over the durable focus.

Archiving a focused node keeps the focus record and makes the view say it is archived;
restoring the node makes that lens active again. Removing a focused node is refused
until focus is deliberately cleared or replaced.

### Needs checking

Checking pressure is not heat. The snapshot lists **Needs checking** independently
for:

- file drift or disappearance relative to a node's stored fingerprint;
- a linked project path that has no fingerprint yet; and
- a graph link to a missing node.

A mapping gap is likewise independent, but appears in its own **Mapping gaps** category
until an active node covers the path or bounded gap retention displaces it. The
appropriate response is to re-read, confirm, relink, or map. The mechanism does not
rewrite the associated durable claim.

### Cold candidates

A node is only an **archive candidate** when it is outside every live category and:

- the Atlas has reached the candidate epoch threshold;
- the node has been cold for that threshold;
- no active node links to it; and
- it has at most one outgoing graph link.

Candidates are advice only. During active work the renderer shows their count; while
idle it can show the reasons. `archive` is explicit and reversible, and `restore`
refreshes the restored node. Nothing in heat or decay automatically archives or removes
an Atlas node.

### Permanent removal gate — approved alignment

Permanent removal is stricter than reversible archive. The existing `confirm` action is
the sole verification path: each successful confirmation records a durable,
removal-eligible receipt for that node. `remove` must then require both that fresh
receipt and a nonempty reason naming why the confirmed node should leave the map.

Conceptually, each receipt binds:

```text
node id + checked-at time + material node version + direct source-state version
```

It is fresh while that same node and its directly checked sources remain materially the
same. There is no arbitrary wall-clock expiry: an edit, link/unlink, rename, relevant
source drift, malformed receipt, or other material mismatch invalidates it. Archive and
restore are reversible view changes, not evidence changes, so they do not by themselves
make a valid receipt stale. A direct check may record a source as gone; the removal gate
then verifies that the observed gone/current state has not changed before accepting the
reasoned removal.

This keeps the surface small: no second verification tool and no generic provenance
framework. Existing and hand-edited nodes simply have no valid receipt until `confirm`
checks them. Cold scores, target overlays, stale signals, or archive-candidate listings
never substitute for confirmation.

The future acceptance suite must prove refusal without a receipt or reason; acceptance
after `confirm`; refusal after node/source mutation; preservation through archive and
restore; and safe handling of missing or malformed legacy receipt data.

Current code does not yet enforce this gate: it refuses removal of the explicit focus,
but otherwise permits removal without a preceding verification record. That is the
remaining implementation mismatch with this document's intended behavior.

## One projection, several consumers

`attentionSnapshot()` and `renderAttention()` are the shared projection used by the
main state block, terminal Atlas view, and screen. They display the same categories:

```text
Focus
Active work
Hot now
Nearby
Mapping gaps
Needs checking
Cold candidates
```

The state/terminal/screen do not independently score heat. The structural Atlas tree
stays in the cache-friendly stable context; this local attention map is freshly derived
at the request tail.

## Verified implementation

The implementation is present in:

- `src/atlas.mjs` — normalization, `observeAtlas()`, `attentionSnapshot()`, rendering,
  focus/archive/restore operations, and active-move overlays;
- `src/harness.mjs` — batches successful factual tool results before one durable
  `observeAtlas()` call;
- `src/state.mjs`, `src/terminal.mjs`, and `src/screen/views.mjs` — shared snapshot and
  renderer consumers; and
- `src/config.mjs` — bounded Atlas-attention policy values.

Offline evidence run on 2026-11-16:

- `npm run test:unit` — **111 passed, 0 failed**. Its Atlas-attention test covers
  durable focus, one-hop warmth, unmapped-path gaps, independent file-drift checking,
  epoch decay, cold-candidate eligibility, reversible archive/restore, rename-stable
  focus, and refusal to remove a focused node.
- `npm run test:ported` — **69 passed, 0 failed, 2 skipped**. The Atlas integration
  test proves a completed read plus shelf batch increments one epoch once, heats an
  existing linked node, records an unmapped shelf path as a gap, and creates no node.
  The two skipped checks require Bubblewrap, which is unavailable in this environment;
  they are unrelated to Atlas attention.

This verifies the implemented offline mechanics and persistence behavior. It does not
verify the approved fresh-confirmation removal gate above, because that gate is not yet
implemented. It also does not claim that a particular model will make good
prioritization choices, nor that attention is a source of evidence about the project
itself.
