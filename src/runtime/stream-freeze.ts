/**
 * The stream freeze behind `^v` (§9).
 *
 * Pausing stops the run where it stands — and, if nothing else is written, lets
 * the very same reply go on when the pause is lifted. Nothing is committed or
 * discarded by a pause, and the agent is not told it happened.
 *
 * pi-ai starts the network read as soon as the provider is called and buffers
 * events in memory, so refusing to pull from the provider's event stream only
 * buffers the whole reply. The freeze therefore sits at the response body: the
 * `fetch` pi hands the provider is wrapped, and the provider is handed a body
 * stream whose `pull()` waits while the gate is frozen. While it waits, nothing
 * reads the upstream socket: the kernel's buffers fill, TCP pushes back, and
 * the server stops mid-token. Opening the gate lets the same `pull()` go on
 * reading the same HTTP response, token for token — no second request, nothing
 * replayed. That is the whole of §9's pause.
 *
 * `abandon` is not a pause: it lets go of every body, so the run ends aborted.
 * It exists for the paths that are interrupting anyway — a line or a command
 * written while the agent is held, `^x`, and a collapse.
 *
 * The gate is per session and covers every conversation the session serves: the
 * models the harness is given are gated once (`gate`), so the agent, its tasks,
 * and its hooks all pass through the same gate. `options.fetch` is pi's own
 * request option for exactly this (`ProviderRequestOptions.fetch`), so nothing
 * about a request changes; only the body that comes back.
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { createModelTelemetry } from "./model-telemetry.js";

export interface StreamFreeze {
  /**
   * Hold a live response body. False when nothing is in flight, so the pause
   * lands on the round of tool calls instead and the agent starts nothing of
   * its own.
   */
  freeze(): boolean;
  /** Let a held body go on. False when none was held. */
  resume(): boolean;
  /** Let go of every body: the connection is torn down and the run ends aborted. */
  abandon(): void;
  /** Whether a body is held right now. */
  frozen(): boolean;
  /** Whether any response body is in flight, held or not. */
  live(): boolean;
  /**
   * The models to hand the harness: the registry's own, except that every
   * request's response body goes through the gate. Call once, before opening.
   */
  gate(models: Models, telemetry?: ReturnType<typeof createModelTelemetry>): Models;
}

/** One upstream body in flight, with its own dying mark. */
interface BodyState {
  dying: boolean;
}

/** The error a body throws when the freeze lets go of it: an abort, not a crash. */
const ABORT = (): Error => Object.assign(new Error("The pause let go of the stream."), { name: "AbortError" });

export function createStreamFreeze(): StreamFreeze {
  let frozen = false;
  /** Every response body in flight, held or not. */
  const bodies = new Set<BodyState>();
  /** Resolvers waiting for the gate to open or the bodies to be let go. */
  let waiters: Array<() => void> = [];
  const settle = () => {
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  };
  // Register first, then re-check: the freeze can lift between `pull`'s check
  // and this push, and a waiter pushed after its signal was consumed would
  // sleep forever. Resolving early is safe — `pull` loops back and parks again
  // if the gate is still frozen.
  const wait = () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (!frozen) resolve();
    });

  /**
   * A body that reads upstream only while the gate is open, and is held
   * mid-stream while it is frozen. The consumer calls `pull` again, so parking
   * here parks the read itself, not the reply.
   */
  const gatedBody = (upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
    const reader = upstream.getReader();
    const state: BodyState = { dying: false };
    bodies.add(state);
    const done = () => bodies.delete(state);
    // A chunk that has been read but not yet handed on. It is delivered only
    // once the gate is open, because a read already in flight when the pause
    // lands comes back with the server's next token: enqueueing it blindly would
    // let the reply creep one token past the pause, which is exactly what the
    // test that guards this refuses.
    let held: Uint8Array | undefined;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        for (;;) {
          if (state.dying) {
            try {
              await reader.cancel();
            } catch {
              // The server is already gone; nothing to let go of.
            }
            controller.error(ABORT());
            done();
            return;
          }
          // While frozen nothing is read and nothing is delivered: the socket
          // stops being drained and the server is pushed back on. This, and only
          // this, is the pause.
          if (frozen) {
            await wait();
            continue;
          }
          if (held !== undefined) {
            controller.enqueue(held);
            held = undefined;
            // Delivery happened; the consumer's next pull comes when it wants
            // more. Looping here instead would spin the gate reading upstream.
            return;
          }
          let reading: { done: boolean; value?: Uint8Array };
          try {
            reading = await reader.read();
          } catch (error) {
            controller.error(error);
            done();
            return;
          }
          if (reading.done) {
            controller.close();
            done();
            return;
          }
          // Read, but not yet given: the loop re-checks the gate above before
          // this chunk reaches the consumer.
          if (reading.value !== undefined) held = reading.value;
        }
      },
      async cancel(reason) {
        state.dying = true;
        try {
          await reader.cancel(reason);
        } catch {
          // The server is already gone; nothing to let go of.
        }
        done();
      },
    });
  };

  /** A `fetch` whose response bodies go through the gate; the request is untouched. */
  const gatedFetch =
    (inner: typeof fetch): typeof fetch =>
    async (url, init) => {
      const upstream = await inner(url, init);
      const body = upstream.body;
      if (body === null || typeof body.getReader !== "function") return upstream;
      return new Response(gatedBody(body), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    };

  return {
    /**
     * A shallow copy of the registry with its two streaming calls gated. Every
     * read and every other method is the registry's own, so auth, the catalog,
     * and refresh behave exactly as they would. The gate belongs here rather
     * than on the provider object because the provider is shared by every
     * session on it (`configuredModels` builds it once): wrapping it would
     * outlive the session that froze it, and double-wrap after a collapse.
     */
    gate(models: Models, telemetry?: ReturnType<typeof createModelTelemetry>): Models {
      const gated = Object.create(models) as Models;
      for (const name of ["stream", "streamSimple"] as const) {
        const inner = models[name].bind(models);
        Object.defineProperty(gated, name, {
          value: (model: { provider?: string }, context: unknown, options: {
            fetch?: typeof fetch;
            onPayload?: (payload: unknown, payloadModel: unknown) => unknown | Promise<unknown>;
            onResponse?: (response: unknown, responseModel: unknown) => void | Promise<void>;
            onProviderStreamEvent?: (event: unknown, model: unknown) => void | Promise<void>;
          } = {}) => {
            const observe = model.provider === "llama-swap" && telemetry !== undefined;
            const id = observe ? telemetry.start() : undefined;
            const stream = inner(model as never, context as never, {
              ...options,
              fetch: gatedFetch(options.fetch ?? globalThis.fetch),
              ...(observe ? {
                onPayload: async (payload: unknown, payloadModel: unknown) => {
                  const next = (await options.onPayload?.(payload, payloadModel)) ?? payload;
                  if (next !== null && typeof next === "object" && !Array.isArray(next) && (next as Record<string, unknown>).stream !== false) {
                    return { ...(next as Record<string, unknown>), return_progress: true, timings_per_token: true };
                  }
                  return next;
                },
                onResponse: async (response: unknown, responseModel: unknown) => {
                  telemetry!.response(id!);
                  await options.onResponse?.(response, responseModel);
                },
                onProviderStreamEvent: async (event: unknown, eventModel: unknown) => {
                  telemetry!.event(id!, event);
                  await options.onProviderStreamEvent?.(event, eventModel);
                },
              } : {}),
            } as never);
            if (id !== undefined) {
              void stream.result().then((message) => telemetry!.end(id, message.stopReason === "error"), () => telemetry!.end(id, true));
            }
            return stream;
          },
        });
      }
      return gated;
    },
    freeze() {
      if (bodies.size === 0) return false;
      frozen = true;
      return true;
    },
    resume() {
      if (!frozen) return false;
      frozen = false;
      settle();
      return true;
    },
    abandon() {
      for (const state of bodies) state.dying = true;
      frozen = false;
      settle();
    },
    frozen: () => frozen,
    live: () => bodies.size > 0,
  };
}
