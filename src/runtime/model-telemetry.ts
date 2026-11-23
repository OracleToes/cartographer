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
}

const nonnegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A stream observer; no invented progress when a server omits its extensions. */
export function createModelTelemetry(state: ModelTelemetry) {
  let current = 0;
  return {
    start() {
      const id = ++current;
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
    event(id: number, value: unknown) {
      if (id !== current || typeof value !== "object" || value === null) return;
      const event = value as Record<string, unknown>;
      const progress = event.prompt_progress;
      if (typeof progress === "object" && progress !== null) {
        const p = progress as Record<string, unknown>;
        const total = nonnegative(p.total);
        const processed = nonnegative(p.processed);
        const cache = nonnegative(p.cache);
        const ms = nonnegative(p.time_ms);
        if (total !== undefined && processed !== undefined && cache !== undefined && processed <= total && cache <= processed) {
          state.prefillTotal = total;
          state.prefilledTokens = processed;
          state.prefillCached = cache;
          if (ms !== undefined && ms > 0 && processed > cache) state.prefillRate = (processed - cache) * 1000 / ms;
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
      const choices = event.choices;
      if (Array.isArray(choices)) {
        for (const choice of choices) {
          const delta = choice?.delta;
          if (delta && (typeof delta.content === "string" && delta.content.length > 0 ||
              typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0 ||
              Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)) state.prefillActive = false;
        }
      }
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
