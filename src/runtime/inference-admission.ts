/**
 * One stream or deferred poll at a time per live session. Provider-side work
 * between deferred polls, other sessions and processes are not coordinated;
 * this does not itself schedule agents.
 */
import type { Models } from "@earendil-works/pi-ai/models";
import type { Api, Model } from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

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
  for (const name of ["stream", "streamSimple", "streamDeferred"] as const) {
    const inner = models[name].bind(models);
    Object.defineProperty(wrapped, name, {
      value: (model: Model<Api>, context: unknown, options: { signal?: AbortSignal } = {}) => {
        let release: (() => void) | undefined;
        // Pi's lazy stream classifies failures by its signal. Preserve the
        // existing AbortError classification even when an inner stream throws
        // that error without aborting the caller's signal.
        const abort = new AbortController();
        const signal = options.signal === undefined ? abort.signal : AbortSignal.any([options.signal, abort.signal]);
        const markAbort = (error: unknown) => {
          if (error instanceof Error && error.name === "AbortError") abort.abort();
        };
        return lazyStream(model, async () => {
          try {
            release = await acquire(options.signal);
            // The signal may have fired between acquisition and this microtask.
            if (options.signal?.aborted) throw abortError();
            const stream = inner(model as never, context as never, options as never);
            return {
              async *[Symbol.asyncIterator]() {
                try { yield* stream; } catch (error) { markAbort(error); throw error; }
              },
              async result() {
                try { return await stream.result(); } catch (error) { markAbort(error); throw error; }
              },
            };
          } catch (error) {
            markAbort(error);
            throw error;
          }
        }, { onResult: () => release?.() }, signal);
      },
    });
  }
  // Do not depend on a registry's convenience methods dynamically dispatching
  // through `this`: every public chat completion path must use this same queue.
  for (const [name, stream] of [["complete", "stream"], ["completeSimple", "streamSimple"], ["fetchDeferred", "streamDeferred"]] as const) {
    Object.defineProperty(wrapped, name, {
      value: (model: Model<Api>, input: unknown, options: { signal?: AbortSignal } = {}) =>
        wrapped[stream](model as never, input as never, options as never).result(),
    });
  }
  return wrapped;
}
