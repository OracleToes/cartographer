/** Per-session observations from llama.cpp's OpenAI-compatible stream. */
export interface ModelTelemetry {
  prefillActive?: boolean | undefined;
  prefillTotal?: number | undefined;
  prefilledTokens?: number | undefined;
  prefillCached?: number | undefined;
  prefillRate?: number | undefined;
  decodeRate?: number | undefined;
  serverLost?: boolean | undefined;
  onTelemetry?: (() => void) | undefined;
  /** Fired once per request when the server responds (model loaded / streaming). */
  onResponse?: (() => void) | undefined;
}

const nonnegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function isGenerationStart(event: Record<string, unknown>): boolean {
  const choices = event.choices;
  if (!Array.isArray(choices)) return false;
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const c = choice as Record<string, unknown>;
    if (c.finish_reason != null) return true;
    const delta = c.delta;
    if (typeof delta !== "object" || delta === null) continue;
    const d = delta as Record<string, unknown>;
    if (
      (typeof d.content === "string" && d.content.length > 0) ||
      Array.isArray(d.content) ||
      (typeof d.reasoning_content === "string" && d.reasoning_content.length > 0) ||
      (typeof d.reasoning === "string" && d.reasoning.length > 0) ||
      (Array.isArray(d.tool_calls) && d.tool_calls.length > 0)
    ) {
      return true;
    }
  }
  return false;
}

/** A stream observer; no invented progress when a server omits its extensions. */
export function createModelTelemetry(state: ModelTelemetry) {
  let current = 0;
  let responded = 0;
  let prevComputed = 0;
  let prevTimeMs = 0;
  const markResponded = (id: number) => {
    if (id !== current || responded === id) return;
    responded = id;
    state.onResponse?.();
  };
  return {
    start() {
      const id = ++current;
      prevComputed = 0;
      prevTimeMs = 0;
      state.prefillActive = true;
      state.prefillTotal = undefined;
      state.prefilledTokens = undefined;
      state.prefillCached = undefined;
      state.prefillRate = undefined;
      state.decodeRate = undefined;
      state.serverLost = false;
      state.onTelemetry?.();
      return id;
    },
    response(id: number) {
      markResponded(id);
    },
    event(id: number, value: unknown) {
      if (id !== current || typeof value !== "object" || value === null) return;
      markResponded(id);
      const event = value as Record<string, unknown>;
      const progress = event.prompt_progress;
      if (typeof progress === "object" && progress !== null) {
        const p = progress as Record<string, unknown>;
        const total = nonnegative(p.total);
        if (total !== undefined) {
          const processed = Math.min(nonnegative(p.processed) ?? 0, total);
          const cache = Math.min(nonnegative(p.cache) ?? 0, total);
          const ms = nonnegative(p.time_ms) ?? 0;
          state.prefillTotal = total;
          state.prefilledTokens = processed;
          state.prefillCached = cache;
          // Delta-based instantaneous rate: heartbeat chunks with unchanged
          // progress or time keep the last valid rate instead of flickering.
          const computed = Math.max(0, processed - cache);
          const dComputed = computed - prevComputed;
          const dTimeMs = ms - prevTimeMs;
          if (dComputed > 0 && dTimeMs > 0) {
            state.prefillRate = (dComputed * 1000) / dTimeMs;
            prevComputed = computed;
            prevTimeMs = ms;
          }
        }
      }
      const timings = event.timings;
      if (typeof timings === "object" && timings !== null) {
        const t = timings as Record<string, unknown>;
        const prompt = nonnegative(t.prompt_per_second);
        const decode = nonnegative(t.predicted_per_second);
        if (prompt !== undefined && prompt > 0) state.prefillRate = prompt;
        if (decode !== undefined && decode > 0) state.decodeRate = decode;
        if ((nonnegative(t.predicted_n) ?? 0) > 0) state.prefillActive = false;
      }
      if (isGenerationStart(event)) state.prefillActive = false;
      state.onTelemetry?.();
    },
    end(id: number, failed: boolean) {
      if (id !== current) return;
      state.prefillActive = false;
      state.serverLost = failed;
      state.onTelemetry?.();
    },
  };
}
