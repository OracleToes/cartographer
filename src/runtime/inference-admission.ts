/**
 * One stream request at a time per live session. This does not coordinate
 * other processes or deferred requests, and does not itself schedule agents.
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

type Waiter = { signal: AbortSignal | undefined; resolve: (release: () => void) => void; reject: (error: Error) => void; cancel: () => void };

export function createInferenceAdmission(models: Models): Models {
  let held = false;
  const queue: Waiter[] = [];
  const abortError = () => Object.assign(new Error("Inference request cancelled while waiting for the model."), { name: "AbortError" });
  const drain = () => {
    if (held) return;
    const next = queue.shift();
    if (next === undefined) return;
    next.signal?.removeEventListener("abort", next.cancel);
    if (next.signal?.aborted) {
      next.reject(abortError());
      drain();
      return;
    }
    held = true;
    let released = false;
    next.resolve(() => {
      if (released) return;
      released = true;
      held = false;
      drain();
    });
  };
  const acquire = (signal: AbortSignal | undefined): Promise<() => void> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const waiter: Waiter = {
      signal, resolve, reject,
      cancel: () => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        signal?.removeEventListener("abort", waiter.cancel);
        reject(abortError());
      },
    };
    queue.push(waiter);
    signal?.addEventListener("abort", waiter.cancel, { once: true });
    drain();
  });
  const wrapped = Object.create(models) as Models;
  for (const name of ["stream", "streamSimple"] as const) {
    const inner = models[name].bind(models);
    Object.defineProperty(wrapped, name, {
      value: (model: Model<Api>, context: unknown, options: { signal?: AbortSignal } = {}) => {
        const output = createAssistantMessageEventStream();
        void (async () => {
          let release: (() => void) | undefined;
          try {
            release = await acquire(options.signal);
            // The signal may have fired between acquisition and this microtask.
            if (options.signal?.aborted) throw abortError();
            const stream = inner(model as never, context as never, options as never);
            for await (const event of stream) output.push(event);
            output.end(await stream.result());
          } catch (error) {
            const aborted = options.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
            const message: AssistantMessage = {
              role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: aborted ? "aborted" : "error",
              errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now(),
            };
            output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
            output.end(message);
          } finally {
            release?.();
          }
        })();
        return output;
      },
    });
  }
  return wrapped;
}
