/**
 * The provider payload, read structurally.
 *
 * Pi hands the hook a payload in the provider's own format, which for the
 * OpenAI-compatible APIs Carto targets is `{ model, messages, tools }` and for
 * Anthropic is `{ model, system, messages, tools }`. This type is deliberately
 * loose: the tree renderer walks whatever the provider was given rather than
 * forcing it through a shape that would drop fields it does not know. A field
 * the renderer does not recognise still appears in the real view, because the
 * real view is the payload's own JSON.
 */
export interface ProviderPayload {
  model?: unknown;
  system?: unknown;
  messages?: readonly ProviderMessage[];
  tools?: readonly unknown[];
  [key: string]: unknown;
}

export interface ProviderMessage {
  role?: string;
  content?: unknown;
  tool_calls?: readonly unknown[];
  tool_call_id?: unknown;
  name?: unknown;
  tools?: readonly unknown[];
  [key: string]: unknown;
}

/**
 * The last prompt the harness assembled, kept for the screen.
 *
 * This is a mirror of a fact, not a cache of a guess: `beforeProviderRequest`
 * hands over the messages Pi is about to send, so the screen shows what was
 * sent rather than what a projection predicted. Three consequences worth
 * stating, because each one was a defect in the earlier design:
 *
 * 1. **It is written by the harness, not by the UI.** The UI has no way to
 *    construct a plausible-looking prompt, so it cannot show one that was never
 *    sent.
 * 2. **A token count arrives separately and later.** The messages are known
 *    before the request; `Usage` is only known after the response. Until then
 *    the tree is structural and its totals are estimates, which the screen must
 *    mark as such.
 * 3. **It survives a UI restart within one process.** The store outlives the
 *    screen frame, so reopening Carto on a live project shows the last real
 *    prompt instead of falling back to an estimate the moment the first frame
 *    is drawn.
 */

export interface PromptSnapshot {
  /** The payload as the provider receives it, untouched. */
  payload: ProviderPayload;
  /** When the request was observed. */
  at: number;
  /** The provider's own count, once the response for this request arrives. */
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export class PromptStore {
  private snapshot: PromptSnapshot | undefined;

  /** Record a request the harness is about to send. */
  observe(payload: ProviderPayload, at = Date.now()): void {
    // A new request invalidates the previous usage: its number counted the
    // previous prompt, and attaching it to this one would be a lie that looks
    // like precision.
    this.snapshot = { payload, at };
  }

  /** Record the provider's count for the request that produced this response. */
  recordUsage(usage: PromptSnapshot["usage"]): void {
    if (this.snapshot === undefined || usage === undefined) return;
    this.snapshot = { ...this.snapshot, usage };
  }

  current(): PromptSnapshot | undefined {
    return this.snapshot;
  }

  clear(): void {
    this.snapshot = undefined;
  }
}
