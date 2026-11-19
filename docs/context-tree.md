# The Context tab is the prompt

Stage: replace Context's flat projection list with the actual prompt, as a fold
tree.

## The requirement

> "the context section is supposed to be a fully accurate representation of
> everything the agent sees, in the order it sees it. if it's applicable, it
> should be foldable and collapsible so that there is a compact way to see it.
> currently the behavior opens up a window on Enter, i think it should be to
> unfold and fold with left and right. the tools section should be collapsible by
> tool, in their own sub-tree ... Can we use the actual tokeniser instead?"

## What was wrong

Context rendered `projectContext(...)` blocks. That is Carto's *plan*, not the
prompt. Measured against what the provider actually receives, it was missing:

- the `<instructions>` block and the `# Carto context` / `## Rules` headings,
- the whole Pi Durable transcript,
- every tool schema,
- request parameters.

It also truncated every long row at the terminal width with `…` and had no way
to open one.

## The answer on tokenisation

**There is no tokeniser in `@earendil-works/pi-ai`.** No `tokenize`, no
`countTokens`, no per-model encoder. Writing one would mean BPE tables per model
plus chat-format overhead — the hand-rolled work that is banned here.

What Pi does provide is better than an estimate and is what this stage uses:

| Mechanism | What it gives |
| --- | --- |
| `beforeProviderRequest` hook (`GenerationTask`) | The finished payload, in the provider's own format, immediately before sending |
| `afterResponse` hook | `AssistantMessage.usage` — the provider's own `input` / `output` / `totalTokens` |

So the tree is built from the payload, and the total comes from the provider.
`len/4` survives only as a fallback before the first request, where no exact
number can exist.

The tree's per-node costs are still proportional cuts of the real total, marked
`▤` because they are estimates. A share is never presented as measured.

## The shape

```
▸ System prompt                    (1)   ← the whole Carto projection, in one message
▸ Person · you                     (1)
▸ Model · tool calls               (1)
▸ Tool result · chat               (1)
▸ Tools                            (9)   ← one child per tool, schema in the human view
· Request settings                       ← stream, max_tokens, temperature
```

- `←` / `→` (and `h` / `l`) fold and unfold the selected node.
- `v` swaps that node between the **human view** and the **real view**. The real
  view is the node's own JSON, so it cannot drift from what was sent.
- A leaf is never folded: it has nothing to hide, and its content is the only
  thing it exists to show.
- Enter no longer opens a page on Context. The window-on-Enter behaviour is gone.

Before the first request there is no payload. The tab says `Nothing sent yet`,
explains that the projection below is Carto's own plan and not the prompt, and
lets the plan be folded. That is the person's choice of the three options put to
them.

## Two defects found by the probe, not the tests

1. **`▤0` beside every node.** `usage` was present but `0` — the fake server
   reports no usage — and a zero total made every share zero while the tree
   claimed to be exact. A zero is not a measurement: the tree is exact only when
   the provider reports a positive count.
2. **Leaves printed nothing.** A leaf was treated as a closed node, so unfolding
   a parent showed a row per child and none of their content. The actual prompt
   text — the thing the whole tab exists to show — was invisible.

## Still open

- **Editing.** The person said "both layers": editing the record behind a node,
  and editing the literal text that is sent. That is the next stage. It must go
  through the approved-patch path for records; a direct prompt edit needs a
  decision about where a literal override is stored.
- **The bar's number** still comes from the prefill monitor's server reading,
  not from `usage.input`. Once a provider reports usage, the bar should prefer
  it; that is a change to `meter.ts` and its own stage.
- A node's `▤` share is proportional, not measured, and there is no per-node
  exact count anywhere — the provider reports one number for the whole request.
