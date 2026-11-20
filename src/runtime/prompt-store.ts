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
 * The last prompt the harness assembled, kept so the state block can report
 * the context honestly.
 *
 * This is a mirror of a fact, not a cache of a guess: `beforeProviderRequest`
 * hands over the messages Pi is about to send, so everything derived from it
 * describes what was sent rather than what a projection predicted. Two
 * consequences worth stating, because each one was a defect in the earlier
 * design:
 *
 * 1. **It is written by the harness, not by any reader.** No reader can
 *    construct a plausible-looking prompt, so nothing downstream of it can
 *    display one that was never sent.
 * 2. **A token count arrives separately and later.** The messages are known
 *    before the request; `Usage` is only known after the response. Until then
 *    any fullness figure derived from the payload is an estimate, and it must
 *    be marked as such.
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
