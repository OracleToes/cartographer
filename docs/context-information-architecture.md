# Talk, work, and the model window — proposal

**Status:** proposal, 2026-11-16. Nothing in this document changes the screen or request path. `docs/design.md` remains the source of intent; the current source and README describe the implementation being proposed against. No live-server claim is made here.

## The problem

Cartographer has three different things worth showing:

1. the talk between the user and the agent;
2. the agent's work while it carries out that talk; and
3. the finite provider request from which the model answers.

They overlap, but they are not versions of one object. The screen currently calls the first **Chat** and the third **Context**, then mixes work, current brain state, a sent snapshot, and a possible next request into both. That makes ordinary questions hard to answer:

- Did the agent say this to me, think it privately, or call a tool with it?
- Was this sent already, is it merely about to be sent, or is it a current brain record?
- Does this row describe the request as it was, or the mutable thing it was made from?
- If I edit or delete it, what changes now, at the next collapse, or never?

The distinction in `docs/design.md` §3 is right: the shared brain is durable project memory; context is finite working memory; talk is the user-agent relationship. The interface must make that distinction visible rather than ask the user to infer it from a tab name.

## Terms this proposal fixes

These names describe different lifecycles. They must not be used as synonyms.

| Term | Meaning | Mutable? | Where it lives now |
|---|---|---:|---|
| **Durable transcript** | Pi Durable's append-only conversation entries: user messages, assistant replies, calls, and results. | No; a soft-forget omits an entry from ordinary active recall but does not erase the raw entry. | `session.sqlite` and Durable storage |
| **Shared brain** | Ledger, plan, atlas, assessment, context store, reports, shelf snapshots, and other `.brain/` records. | Yes, through their own operations. | `.brain/` |
| **Talk source** | The mutable `store.chat` list used when a later collapse writes the kept talk. It is not the conversation transcript. | Yes. | `.brain/carto-context.json` |
| **Active conversation** | The Durable entries from which the next generation request is built. | It changes as entries arrive, are omitted, or a context is collapsed. | Durable conversation view |
| **Sent provider request** | One provider-format payload after Cartographer has dressed messages and pi-ai has built the request body. | No. It is a historical snapshot. | In memory in `engine.sending()`; optionally the raw wire trace |
| **Response since that request** | The reply and call results that arrived after a sent snapshot. | It grows while work runs. It has not yet been part of that snapshot. | Durable/live response state and `engine`'s result map |
| **Next-request preview** | A non-mutating calculation of what a later request would contain if one were built now. | Yes, and it may never be sent. | Proposed only |

“Model context” should mean a request snapshot or a clearly labelled prospective request. “What the agent sees” is too broad for either: the server may apply a chat template after receiving the payload, and the screen cannot inspect the model's hidden token sequence or cache state.

## What happens now

### The request path

The authoritative path is narrower than either screen tab.

1. Durable supplies the active conversation messages.
2. `src/harness.mjs` calls `dressRequest()` before each generation attempt.
3. `src/request.mjs` dresses those messages without rewriting the stored conversation. It drops obsolete wakes, applies main/task context dressing, adds user names and request-time stamps, marks no-call assistant replies as `Note to self:`, adds the cached top block, a fresh state block, a fresh windows block, and the current successful read batch at the tail.
4. pi-ai turns the dressed messages into the provider API's request body. In `beforeProviderRequest`, `engine.sending()` receives that provider body immediately before it is sent.
5. `src/engine.mjs` retains only the newest payload per conversation, its response, and returned-call text. `window("main")` chooses the main conversation; `window("newest")` chooses whichever main or focus request was sent most recently.

This is the best in-process account of the provider payload. `CARTO_TRACE` is the stronger wire audit when it is enabled: it records the JSON sent over the connection and the raw response stream. Neither representation proves the prompt string after a server-specific template has been applied inside the model server.

The response is not part of the payload it answered. A later request may replay it, but only after more transformations. For example, a no-call reply receives `Note to self:` on replay; state and windows are regenerated; a later successful read batch replaces an earlier tail; a collapse may replace much of the active conversation; and provider compatibility rules may retain, redact, or omit reasoning when models differ.

### What the Chat tab represents

`src/screen/chat.mjs` is an event-driven, local activity projection.

- A typed user message becomes a `user` item immediately.
- A successful-looking `chat` tool call becomes an `agent` item: this is the only assistant path intentionally presented as speech to the user.
- Model thinking and ordinary assistant text are joined by `noteOf()` and shown as the same `note` stream. A reply with text and calls therefore appears as private notes beside work even though it is an assistant message in a provider request.
- Calls and results are grouped, abbreviated, and sometimes linked to other tabs. Cartographer notices are separate console items.
- The current live reply is a live projection, not a stored request. Its visible reasoning and plain text are deliberately combined.
- On a main-context collapse, `chat.collapse()` removes almost all local items. Its item limit can also trim older activity. Neither action means that the raw Durable transcript was erased.
- At startup, the screen can rebuild a Chat-like replay by redressing current stored messages. That replay is another projection; it is not the captured payload from a past send.

So Chat is useful as an activity feed, but it is neither “the conversation in full” nor a serialized model context. Its current title and README description promise both.

### What the Context tab represents

The Context tab contains several temporal objects under one heading.

- **Window** parses the last provider payload of whichever conversation sent most recently. **Main agent** parses the last main-agent payload instead. The selector is useful, but the scope can change silently when a focus sends a request.
- `contextView()` shows that payload's system message, tools, and messages in request order. It then appends a divider and the current reply/results as “what the next one will hold as well.” The material above the divider is sent history; the material below it is not yet sent and is not a guaranteed future request.
- **Parts** runs `/context` again. It is a fresh current accounting, not an inspection of the selected sent request.
- **Hands** reads the current context store, shelf, and reports. It is a current shared-brain editor, not a part of the selected request.

Even the Window's sent portion is a semantic rendering, not a byte-for-byte payload viewer. `partsOfMessage()` finds injected blocks by text patterns, trims them, reparses call JSON for display, and infers categories from role and text prefixes. It does not show request options outside messages/tools, and it cannot retain provenance that the provider body did not carry.

The collapse folder has a more serious snapshot breach. Its outer row comes from the captured `<context>…</context>` text, but `keptChildren()` unfolds current `carto-context.json`, current ledger notes, and current shelf/report state. A request sent yesterday can therefore show child rows changed today while its header says it is the request the model was sent. The existing screen test explicitly relies on this live unfolding (`test/run.mjs`, “the Context tab unfolds the collapse block”).

### Current edit and delete behavior

The current labels also conceal several different operations.

| Gesture today | What it changes | What it does not change | When the model can observe it |
|---|---|---|---|
| `e` in Chat on a user or user-facing agent item | The local Chat item and the last text-equal `store.chat` saying, if one exists. | Durable conversation entry; already sent payload; active request already in progress. | A later collapse can copy the rewritten talk source. |
| `e` in Chat on a note | The local Chat item only. | Talk source, Durable entry, sent payload, and future request. | Never, unless another independent record changes. |
| `e` in Context on a chat-labelled part | A local replacement map, then the last text-equal talk source it can find. A sole `chat` call has a more direct text path; generic assistant parts do not. | Durable conversation entry and the captured payload. | Only a later collapse sees a changed talk source. |
| `d` in Context on a chat-labelled part | The last text-equal talk-source saying and local Context/Chat display state. | Durable transcript, existing sent payload, and the currently active conversation. | A later collapse omits it from kept talk. |
| Agent `book target=message, action=edit` | A Durable omission marker plus related context-store cleanup. | The append-only raw transcript and earlier payload snapshots. | A later request built from the revised active conversation. |

The first four actions use text matching, not a stable message identity. They can select the latest equal wording rather than the row the user meant. The delete confirmation says that a message “goes for good,” although it only removes the mutable talk source and local view. Chat's legend also advertises `d forget`, but the Chat command path does not implement a delete action.

The outcome must be stated in the interface, not left in comments or flash text. Editing words for a future collapse, hiding an item from a view, omitting a Durable message from active recall, and deleting a brain record are distinct operations.

### Other mismatches worth preserving in the design

- The Context header's “the server counted” value is `input + cacheRead + output` in `engine.replied()`. It is useful total usage/accounting, but it is not a measured size of the sent input alone and should not be placed as proof of the input bar.
- The read-batch tail is intentionally transient. A newer successful read batch replaces it without a collapse. It needs a lifecycle label, not the appearance of a durable result.
- A `chat` call is displayed as speech before its tool result is known. On failure Chat adds a warning after an already-visible saying. Pending, delivered, and failed speech need distinct states.
- Provider reasoning is not equivalent to user-visible speech or an agent note. It may be redacted, signed, model-specific, or omitted when a provider/model changes. A display of it must say what it is and whether it can replay.
- The request inspector is in-memory and only holds the latest request per conversation during this run. Its lifetime is itself important provenance.

## Proposed information architecture

Keep the existing shared brain as a separate, live thing. Divide the present Chat/Context mixture into three explicit views.

### 1. Talk — the user-agent conversation

**Purpose:** answer “what did we say to each other?”

Talk contains only:

- user messages directed to the agent;
- agent speech delivered through a successful `chat` call; and
- blocking questions and answers when they are genuinely addressed to the other party.

A `chat` call is first shown as **Agent speech · sending**. It becomes **Agent speech · delivered** only with its successful result; a failed call stays in Work as a failed attempt and does not read as a statement the agent made. Speech from a focus says **Agent speech · focus**, not a different-agent name.

Each row carries a stable source reference and concise lifecycle text, for example:

```
14:02  You → agent     sent · Durable message m42 · active
14:03  Agent → you     delivered · chat call c17 · kept in talk source
```

“Kept in talk source” means that the saying is eligible for a future collapse, not that it is in every present request. A sent snapshot may still contain older wording. A Talk row links to its Work event and to every captured request that includes the underlying Durable message; it does not pretend those are the same thing.

Private model text and reasoning do not appear in Talk. That makes the talk the steering wheel described by the design rather than a record of everything the model happened to write.

### 2. Work — the agent's private trace

**Purpose:** answer “what happened while the agent worked?”

Work is chronological and can fold runs, as the current Chat activity feed does, but every row has explicit origin, audience, and lifecycle. It contains:

- provider reasoning, labelled **Private reasoning**;
- assistant ordinary text not delivered with `chat`, labelled **Agent note**;
- calls, results, refusals, task starts/returns, and shell progress;
- harness events: collapse, read-tail replacement, wake, state injection, retry, and interruption; and
- links to durable reports and brain changes.

A row uses a small fixed grammar rather than category inference:

```
14:04  Main · private reasoning · provider response · replay: same model only
14:04  Main · agent note          · sent in request #24 as assistant text
14:04  Main · call read           · completed · result in request #24
14:05  Harness · collapse         · active context replaced · transcript retained
```

The current Ctrl-T behavior can remain the disclosure control for private material; it should hide Work's private rows, not silently turn them into talk. Reasoning should be treated as provider-supplied private response material, not as a claim about hidden cognition or a promise that it will be replayed.

Talk and Work may share the existing first tab as named sibling views during migration. They are still separate projections with separate filters; opening a call in Work never changes Talk's meaning.

### 3. Model — sent request and next-request preview

**Purpose:** answer separately “what was sent?” and “what would be sent if a request were built now?”

The Model tab begins with an explicit scope card:

```
Sent provider request
Main agent · request 23 · attempt 1 · sent 14:02 · retained until this run ends
Frozen after provider formatting. This is the payload sent to the provider, not a claim about the server's hidden prompt.
```

A focus request says its focus id/purpose. The selector names its behavior plainly:

- **Latest sent** — follows the newest request from any conversation;
- **Main sent** — stays on the newest main-agent request; and
- a selected focus, when one is available, stays pinned until the user changes it.

The sent pane is read-only and frozen. It has two synchronized representations:

1. **Payload** — the canonical provider JSON/body, including model/request options that affect the provider call, with a copy/export action; and
2. **Reading order** — the familiar part list, built from provenance captured during dressing rather than from regexes. Every part links to its source and says whether it is a static prompt, a frozen brain copy, a Durable message, a result, a regenerated state block, or a transient read tail.

A sent collapse block unfolds from its own frozen text only. If a current ledger, shelf, or context-store object has changed since the request, the row says, for example, **current ledger note differs — open current brain record**, rather than replacing the snapshot's old words.

Below it, a separate section is never called part of the sent request:

```
Since request #23 · not sent
Response received; 2 calls complete. A later request may transform or omit this material.
```

The adjacent **Next request preview** is explicitly prospective:

```
Next request preview · not sent
Rebuilt at 14:05 without consuming wakes. State, windows, read tail, collapse, or a new message can change it before any provider call.
```

It is a pure calculation from the current active conversation and current brain. It may show a structured difference from the sent snapshot, but it may not be exported or worded as a historical payload. If no further request is possible or planned, it says that rather than implying one exists.

### The shared brain stays live and separate

The current Hands material belongs with the Brain/Carto views, where it can honestly be called **Current shared brain**. The Model tab may link to a record's current source, but never renders a mutable brain object as though it were part of a frozen request.

The Brain view should distinguish a current record from a copied request part:

```
Ledger note n3 · current durable record · changed after request #23
Included in request #23 as collapse snapshot · open frozen copy
```

This preserves the productive relationship in the design: both user and agent operate the same shared brain, while the model window is only a finite cache made from it.

## A common provenance model

The three views must derive from shared facts, not each infer intent differently from strings. The implementation should introduce an internal presentation record along these lines:

```text
artifact id           stable event/message/call/result/request-part identity
kind                  talk | speech | reasoning | note | call | result | harness | brain | request-part
origin                user | model | tool | harness | durable-brain
addressed to          user | model | both | neither
produced at           source timestamp, when known
source                Durable entry/call id, brain record id, or provider payload path
lifecycle             transcript | brain-current | active | sent(request id) | since-send | preview
replay status         replayable | model-bound | omitted | unknown
```

A request snapshot adds:

```text
request id / conversation id / main-or-focus / attempt / sent-at
provider and model identity
frozen canonical payload and payload hash
provider usage fields kept separately by their raw names
ordered part provenance and the exact text/JSON fragment each part rendered from
```

This is not a new user setting. It is the data needed for one truthful rendering. It also removes fragile rules such as “text beginning `Cartographer:` is harness text” and “the latest equal string is the same message.”

The request builder should expose a pure planning result before it formats messages for the provider. Both the live send and the preview consume that result. Only the live send may check/consume wakes, update request counters, or store a snapshot. This gives the preview a defined boundary and makes it testable.

### Required row taxonomy

The following rows must remain distinct even when they share words or a timestamp.

| Row | Source of truth | Audience | Required lifecycle language |
|---|---|---|---|
| **User message** | Durable user entry, with an optional talk-source counterpart | Agent; it is also visible to the user as their own speech | received; active/omitted; included in sent request #N when applicable |
| **Agent speech** | `chat` call plus its result, and the talk source written by the tool | User | sending, delivered, or failed; eligible for future kept talk is separate from sent history |
| **Private reasoning** | Provider response thinking/reasoning block | Model/provider replay path, not user-directed speech | response-only; replayable, model-bound, redacted, or omitted — never simply “chat” |
| **Agent note** | Assistant text that is not delivered through `chat` | Agent/model | response-only or included in a named later request; no-call replay adds `Note to self:` |
| **Call / result** | Durable assistant tool call and Durable tool result | Agent/model; result may also have a user-facing consequence | pending, completed, refused, interrupted, or collapsed; identify the request(s) that carried it |
| **Durable brain record** | Named `.brain/` record | Both parties through the shared brain | current record; copied into a named sent top/state/front snapshot only when that happened |
| **Sent request part** | Frozen provider payload fragment | Provider/model for one completed send | sent once in request #N; immutable; retained only for the advertised inspector lifetime |
| **Next-request part** | Pure current planning result | No one yet | preview only; not sent; conditions that can invalidate it are named |

## Explicit mutation vocabulary

Do not overload `e` and `d`. The UI needs actions named for their scope.

| Proposed action | Exact effect | Explicit non-effect |
|---|---|---|
| **Reword future kept talk** | Changes the identified talk-source entry used by a future collapse. | Does not change the transcript, active request, or any sent snapshot. |
| **Remove from future kept talk** | Removes the identified talk-source entry. | Does not erase it or remove it from the current active conversation. |
| **Hide in this view** | Changes only local presentation state. | Does not change any model or durable state. |
| **Soft-forget active message** | Adds the Durable omission marker for one stable message entry; future active-context construction omits it. | Does not erase the append-only raw entry or change earlier sent snapshots. |
| **Edit current brain record** | Changes the named ledger/plan/atlas/assessment/shelf/context record through its own operation. | Does not retroactively alter a copied top, state, or collapse part in a sent request. |
| **Delete durable brain record** | Uses that record type's existing confirmed delete operation. | Does not rewrite transcript or snapshots. |

A sent request has no edit or delete affordance. At most it can receive a separate user annotation; an annotation must not change the payload it describes.

## Staged implementation

This proposal intentionally separates truth work from visual polish.

### Stage 0 — agree the contract

Accept or change the terms, view boundaries, and mutation table above. In particular, decide whether an in-memory sent-request history is enough, or whether future work needs an explicitly retained request audit. Do not create a silent second unbounded transcript: raw wire retention remains the opt-in `CARTO_TRACE` policy unless a separate retention decision changes it.

### Stage 1 — capture facts once

1. Give each provider attempt a request identity and freeze/deep-copy the payload at `beforeProviderRequest`.
2. Preserve provider/model identity, request options, raw usage fields, response/call links, and source identities.
3. Refactor request dressing into a pure plan plus the small live effects that must remain live.
4. Capture ordered part provenance while building the plan. Do not parse a completed payload to rediscover authorship or lifecycle.
5. Keep the present Context display available behind the existing implementation while fixtures compare it with the new facts.

### Stage 2 — make sent and prospective time separate

1. Replace the Window heading with **Sent provider request** and make main/latest/focus scope explicit.
2. Render frozen payload parts from the snapshot. Remove current-store unfolding from a sent collapse block.
3. Move response/results below a clearly marked **Since request — not sent** boundary.
4. Add the non-mutating **Next request preview** as a separate view, never as an extension of a sent request.
5. Split accounting into estimated sent input, provider-reported input/cache fields, and output/total usage. Do not use one number as all three.

### Stage 3 — separate Talk from Work

1. Make Talk contain only two-party speech, with pending/delivered/failed status for `chat`.
2. Move reasoning, notes, calls/results, and harness events to Work with source and replay markers.
3. Preserve the useful grouping, folding, Markdown rendering, live tail, task links, and Ctrl-T disclosure behavior from the current Chat projection.
4. Move Hands to the live Brain area and replace mutable-in-snapshot rows with source links and divergence badges.

### Stage 4 — make mutations truthful

1. Replace text-match edit/delete plumbing with stable source identities.
2. Offer the six actions in the mutation table with the exact effect in the confirmation copy.
3. Keep soft-forget distinct from future-kept-talk editing and from durable record deletion.
4. Update README, command help, screen legends, and agent-facing wording together. In particular, do not say that a current active request reads rewritten talk before a later collapse actually makes that true.

No stage changes the authorization envelope/move system, context limits, collapse keep-set, transcript retention policy, or the shared brain's operation engine.

## Verification plan

The work is suitable for the existing offline suite. It should not need a live model server to establish the screen's own truthfulness.

1. **Request snapshot fixture.** Build a main and a focus request with prompt/tools, top/front blocks, user message, note, assistant text/reasoning/call, results, state, windows, and read tail. Assert that the frozen payload is the exact object passed through `beforeProviderRequest`, including request options, and that the semantic part order points to exact frozen fragments.
2. **Snapshot isolation.** Capture a request, then change a ledger note, shelf, context talk source, state, and windows. Assert that Sent remains byte/structure-identical while Brain and Next preview show the current changes and their divergence.
3. **Time boundary.** Assert that reply/results after a request never count as sent payload parts. Assert that a no-call reply, a read-tail replacement, a collapse, a new user message, and a model/provider change can each make the next preview differ or disappear.
4. **Scope selection.** Run main and focus requests in alternating order. Assert that Latest, Main, and a pinned focus retain the advertised identity rather than silently changing with the newest request.
5. **Talk/work classification.** Cover user speech, successful/pending/failed `chat`, task speech, plain assistant text, thinking, calls, results, harness notices, and a response cut at the output limit. No private reasoning or ordinary assistant note may appear as delivered talk.
6. **Mutation matrix.** For every action in the table, assert the changed source, unchanged sent snapshot, unchanged append-only transcript where promised, and the first later request or collapse where the effect is observable.
7. **Accounting.** Assert that prompt/input, cache, output, total usage, and rough estimates have separate labels and cannot be substituted in the sent-input bar.
8. **Screen regression.** Exercise narrow columns, folded/open rows, copy/export, live response updates, collapse, and the existing ten-second test budget. Existing tests that deliberately unfold current store data under a historical request must change to assert snapshot isolation instead.

One deliberate live observation remains useful after the offline work: enable `CARTO_TRACE` on a throwaway project and compare the selected Sent payload's canonical hash/body with the trace request. Report the result as one server/model observation, not as proof about every provider or the model's hidden prompt.

## Acceptance test for the design

The redesign is ready to implement only when a user can select any row and answer, from the screen alone:

1. What is this: talk, private work, a durable brain record, a sent payload part, or a preview?
2. Who produced it and who was it addressed to?
3. Was it sent, is it current mutable state, or is it only prospective?
4. Where is its source, and will it survive a collapse or a restart?
5. If I act on it, exactly which later request, record, or view changes — and which historical things remain unchanged?

If a label cannot answer those questions, it is not yet an honest information architecture.
