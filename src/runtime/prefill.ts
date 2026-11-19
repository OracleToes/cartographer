/**
 * How far a llama.cpp server is with reading a prompt.
 *
 * Pi Durable builds and sends the model request itself, so Carto cannot add a
 * field to that request through the Harness. It can wrap the `Models` object
 * that the Harness is given, though: Pi AI lets a caller supply `onPayload`
 * and `fetch`, and those two are enough. `onPayload` asks llama.cpp to report
 * progress (`return_progress`); `fetch` reads the reply's body a second time
 * and leaves the reply itself untouched.
 *
 * Nothing here parses the model's answer. Carto keeps Pi's one stream parser.
 */

/** One `prompt_progress` report, in prompt tokens. */
export interface PrefillProgress {
  total: number;
  cache: number;
  processed: number;
  time_ms?: number;
}

export type PrefillPhase = "sent" | "reading" | "writing";

export interface PrefillState {
  phase: PrefillPhase;
  total: number;
  cache: number;
  processed: number;
  /** The server's own reading time, in ms, at the last report. */
  ms?: number;
  /** When the request left, from the runtime clock. */
  began: number;
  /** When the last report arrived, from the runtime clock. */
  updatedAt: number;
}

export interface PrefillMonitor {
  /** The state of the newest request, or undefined before the first one. */
  current(): PrefillState | undefined;
  /** The last finished reading, so the person can see how long it took. */
  last(): { fresh: number; ms: number; at: number } | undefined;
  /** Notified after each change, so a screen can mark itself dirty. */
  subscribe(listener: () => void): () => void;
  /** The wrapper for a `Models` object; for a host that must not be touched, it returns the original. */
  wrap<T extends object>(models: T): T;
  /** Stop listening. Idempotent. */
  dispose(): void;
}

export interface PrefillMonitorOptions {
  /** The provider whose request gets `return_progress`. Other providers pass through untouched. */
  provider: string;
  /** The clock, for tests. */
  now?: () => number;
  /** The fetch the provider would use; tests replace it. */
  fetch?: typeof globalThis.fetch;
}

const PROGRESS = "prompt_progress";
const TOKEN_FIELD = /"(?:content|reasoning_content|tool_calls)"\s*:\s*(?!null)/;

export function createPrefillMonitor(options: PrefillMonitorOptions): PrefillMonitor {
  const now = options.now ?? (() => Date.now());
  const listeners = new Set<() => void>();
  let state: PrefillState | undefined;
  let last: { fresh: number; ms: number; at: number } | undefined;
  let disposed = false;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const begin = (): number => {
    state = { phase: "sent", total: 0, cache: 0, processed: 0, began: now(), updatedAt: now() };
    notify();
    return state.began;
  };

  const report = (id: number, began: number, progress: PrefillProgress | undefined): void => {
    if (disposed) return;
    // A late frame from an older request must not move the bar of a newer one.
    if (state === undefined || state.began !== began || id !== currentId()) return;
    const at = now();
    if (progress === undefined) {
      state = { ...state, updatedAt: at };
    } else {
      state = {
        phase: "reading",
        total: progress.total,
        cache: progress.cache,
        processed: progress.processed,
        ...(progress.time_ms === undefined ? {} : { ms: progress.time_ms }),
        began,
        updatedAt: at,
      };
    }
    notify();
    void id;
  };

  let serial = 0;
  const currentId = (): number => serial;

  const writing = (id: number, began: number): void => {
    if (disposed) return;
    if (state === undefined || state.began !== began || id !== currentId()) return;
    if (state.phase === "writing") return;
    state = { ...state, phase: "writing", updatedAt: now() };
    notify();
  };

  const done = (id: number, began: number): void => {
    if (disposed) return;
    if (state === undefined || state.began !== began || id !== currentId()) return;
    const fresh = Math.max(0, state.total - state.cache);
    if (fresh > 0) {
      last = { fresh, ms: Math.max(0, now() - began), at: now() };
      state = { ...state, phase: "writing", updatedAt: now() };
    } else {
      // The server never reported a reading (not llama.cpp, or an error). Do
      // not leave a meter that claims to know something: fall back to the
      // estimate, which is visibly an estimate.
      state = undefined;
    }
    notify();
  };

  return {
    current: () => (disposed ? undefined : state),
    last: () => last,
    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    wrap<T extends object>(models: T): T {
      const target = models as unknown as Itself;
      if (typeof target.stream !== "function" || typeof target.streamSimple !== "function") return models;
      const original: Itself = {
        stream: target.stream.bind(target) as StreamCall,
        streamSimple: target.streamSimple.bind(target) as StreamCall,
      };
      const monitored = Object.create(target) as Itself;
      const wrap = (name: "stream" | "streamSimple"): void => {
        monitored[name] = (model: unknown, context: unknown, requestOptions?: Record<string, unknown>) => {
          if (!isObject(model) || model.provider !== options.provider) {
            return original[name](model, context, requestOptions);
          }
          const id = ++serial;
          const began = begin();
          const inner = (requestOptions ?? {}) as Record<string, unknown>;
          return original[name](model, context, {
            ...inner,
            onPayload: async (payload: unknown, of: unknown) => {
              const previous = inner.onPayload;
              const next =
                typeof previous === "function" ? await (previous as (value: unknown, model: unknown) => unknown)(payload, of) : payload;
              const value = next ?? payload;
              return isObject(value) && value.stream === true ? { ...value, return_progress: true } : value;
            },
            fetch: async (url: string | URL | Request, init?: RequestInit) => {
              const fetch = (inner.fetch as typeof globalThis.fetch | undefined) ?? options.fetch ?? globalThis.fetch;
              const response = await fetch(url, init);
              if (!response.ok || response.body === null || typeof response.body.tee !== "function") return response;
              const [mine, theirs] = response.body.tee();
              void readProgress(mine, id, began, report, writing, done);
              return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
            },
          });
        };
      };
      wrap("stream");
      wrap("streamSimple");
      return monitored as unknown as T;
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

type StreamCall = (model: unknown, context: unknown, options?: Record<string, unknown>) => unknown;

interface Itself {
  stream: StreamCall;
  streamSimple: StreamCall;
}

async function readProgress(
  body: ReadableStream<Uint8Array>,
  id: number,
  began: number,
  report: (id: number, began: number, progress: PrefillProgress | undefined) => void,
  writing: (id: number, began: number) => void,
  done: (id: number, began: number) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of body) {
      rest += decoder.decode(chunk as Uint8Array, { stream: true });
      for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
        const line = rest.slice(0, at).trim();
        rest = rest.slice(at + 1);
        if (!line.startsWith("data: {")) continue;
        if (line.includes(`"${PROGRESS}"`)) {
          const progress = parseProgress(line);
          if (progress !== undefined) report(id, began, progress);
        } else if (TOKEN_FIELD.test(line)) {
          // The first answered token ends the reading phase. The test is a
          // guess, so it only ever moves the bar forward once.
          writing(id, began);
        }
      }
    }
  } catch {
    // The stream ended early, the request was aborted, or the body is not
    // text. None of these is a reason to fail the model request.
  } finally {
    done(id, began);
  }
}

/** One `data: {…}` line, or undefined when it is not a progress frame. */
export function parseProgress(line: string): PrefillProgress | undefined {
  try {
    const value = JSON.parse(line.slice(6)) as { prompt_progress?: unknown };
    const raw = value[PROGRESS];
    if (!isObject(raw)) return undefined;
    const total = number(raw.total);
    const cache = number(raw.cache);
    const processed = number(raw.processed);
    if (total === undefined || cache === undefined || processed === undefined) return undefined;
    const time = number(raw.time_ms);
    return { total, cache, processed, ...(time === undefined ? {} : { time_ms: time }) };
  } catch {
    return undefined;
  }
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
