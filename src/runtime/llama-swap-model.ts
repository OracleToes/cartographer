/**
 * The llama-swap provider (MINI.md §11 — Pi AI owns the provider layer).
 * Rewritten fresh for the rebuild, informed by main's documented approach:
 *
 * - keyless: llama-swap serves keyless llama.cpp locally; Pi's OpenAI client
 *   needs a non-empty internal value, and the `authorization: null` header
 *   removes the resulting Authorization header before the request leaves;
 * - OpenAI-compatible `/v1` endpoint, openAI-completions API;
 * - llama.cpp's OpenAI-compatible server accepts streamed usage: it honours
 *   `stream_options.include_usage` and finishes the stream with a `usage`
 *   chunk (prompt/completion tokens) — verified against ggml-org/llama.cpp's
 *   own server test suite (tools/server/tests) on 2026-11-20. llama-swap
 *   proxies that chunk through; pi-ai parses it, and the state block anchors
 *   its fullness line on the last reported input.
 * - llama.cpp accepts system messages but not the developer role,
 *   reasoning_effort, or store; max_tokens field, not max_completion_tokens;
 * - the window: the person's configured `contextWindow` always wins — it is
 *   a hard override, not a ceiling, and may raise the server's number. With
 *   no config, the server's advertised capacity is the truth. With neither,
 *   the window is 0 — unknown; pi treats contextWindow <= 0 as unclamped,
 *   and the UI renders "window unknown", never a made-up number.
 *
 * Catalog dynamics go through Pi's own machinery, not a hand-rolled probe:
 * `refreshModelsAuth: "configured"` (a keyless server is configured when its
 * endpoint is) and `fetchModels` maps the server's `/v1/models` listing onto
 * Model objects, reading capacity from top-level `context_length`, then
 * `context_window`, then legacy `meta.n_ctx`. Pi restores the last persisted
 * catalog before the network phase, runs the refresh through
 * `Models.refresh()`, and publishes transactionally; on a fetch error the
 * error lands in the refresh result's error map and the previous catalog
 * stands (retain-on-failure by design). The driver calls `refresh()` once
 * before opening the session and after every settled run — once llama.cpp
 * has loaded a model, its true capacity rides the next request.
 */
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { ConfigError, type GlobalConfig, type ModelRef } from "./config.js";

export const LLAMA_SWAP_PROVIDER_ID = "llama-swap";

/**
 * pi's Model requires maxTokens and always sends max_tokens; with an unknown
 * window (contextWindow <= 0) pi skips its clamp, so this sentinel — int32
 * max — means "as many tokens as the server's real context allows", which
 * llama.cpp honours by generating until done or context exhausted.
 */
export const UNKNOWN_MAX_TOKENS = 2_147_483_647;

/**
 * The active context window. The person's configured number always wins —
 * it may raise the server's advertised capacity (a hard override, the
 * reverse of a ceiling). With no config, the server's advertised capacity is
 * the truth. With neither, 0 — unknown.
 */
export function resolveContextWindow(configured?: number, advertised?: number): number {
  if (configured !== undefined && configured > 0) return configured;
  if (advertised !== undefined && advertised > 0) return advertised;
  return 0;
}

/** pi's maxTokens for a window; the sentinel when the window is unknown. */
export function maxTokensFor(window: number): number {
  return window > 0 ? window : UNKNOWN_MAX_TOKENS;
}

export const LLAMA_SWAP_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsStore: false,
  supportsUsageInStreaming: true,
  maxTokensField: "max_tokens",
} as const;

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;
export interface LlamaSwapDeps {
  fetchImpl?: FetchLike;
}

/** Capacity advertised by one listing entry; field order per llama-swap and legacy llama.cpp. */
export function advertisedCapacityOf(entry: unknown): { capacity: number; source: "context_length" | "context_window" | "meta.n_ctx" } | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const pick = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  const direct = pick(record.context_length);
  if (direct !== undefined) return { capacity: direct, source: "context_length" };
  const mirror = pick(record.context_window);
  if (mirror !== undefined) return { capacity: mirror, source: "context_window" };
  const meta = record.meta;
  if (typeof meta === "object" && meta !== null) {
    const legacy = pick((meta as Record<string, unknown>).n_ctx);
    if (legacy !== undefined) return { capacity: legacy, source: "meta.n_ctx" };
  }
  return undefined;
}

/**
 * One server-listing entry as a Model, or undefined when it names no usable
 * id. The window is the configured pin when the person set one, else the
 * advertised capacity, else 0 (unknown).
 */
export function catalogModel(entry: unknown, configured: number | undefined, endpoint: string): Model<"openai-completions"> | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.trim() === "") return undefined;
  const advertised = advertisedCapacityOf(record);
  const contextWindow = resolveContextWindow(configured, advertised?.capacity);
  return {
    id: record.id,
    name: record.id,
    api: "openai-completions",
    provider: LLAMA_SWAP_PROVIDER_ID,
    baseUrl: endpoint,
    contextWindow,
    maxTokens: maxTokensFor(contextWindow),
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { ...LLAMA_SWAP_COMPAT },
  };
}

export function modelsForConfig(config: GlobalConfig, model: ModelRef, deps: LlamaSwapDeps = {}): Provider {
  if (model.provider !== LLAMA_SWAP_PROVIDER_ID) {
    throw new ConfigError(
      `This build wires the llama-swap provider only; "${model.provider}" is not supported yet. ` +
        `Use "llama-swap/<modelId>" (see --help).`,
    );
  }
  if (config.llamaSwapEndpoint === undefined) {
    throw new ConfigError(
      "A llama-swap model needs llamaSwapEndpoint in the global config. " +
        "Add it, or recreate the file with --endpoint (see --help).",
    );
  }

  const configured = config.contextWindow;
  const baselineWindow = resolveContextWindow(configured, undefined);
  const endpoint = config.llamaSwapEndpoint;
  const fetchImpl: FetchLike = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const baseline = {
    id: model.modelId,
    name: model.modelId,
    api: "openai-completions" as const,
    provider: LLAMA_SWAP_PROVIDER_ID,
    baseUrl: endpoint,
    contextWindow: baselineWindow,
    // pi clamps this to the room left in the window on every request (when
    // the window is unknown, pi sends this as-is — the sentinel). No
    // artificial cap of Carto's.
    maxTokens: maxTokensFor(baselineWindow),
    input: ["text" as const],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { ...LLAMA_SWAP_COMPAT },
  };

  return createProvider({
    id: LLAMA_SWAP_PROVIDER_ID,
    name: "llama-swap",
    baseUrl: endpoint,
    auth: {
      apiKey: {
        name: "Keyless llama-swap server",
        resolve: async () => ({ auth: { apiKey: "unused", headers: { authorization: null } } }),
      },
    },
    // `refreshModelsAuth` ("configured") exists on pi's Provider type but
    // createProvider does not forward it; the default "credential" path is
    // sufficient here regardless — the keyless apiKey resolve always yields a
    // credential, so the network phase runs. OAuth is absent, so no token can
    // ever be refreshed. Revisit if pi exposes the declaration on the input.
    models: [baseline],
    fetchModels: async (context) => {
      if (!context.allowNetwork) return [];
      const base = (context.baseUrl ?? endpoint).replace(/\/+$/, "");
      // Errors propagate into the refresh result's error map; the previous
      // catalog stands (pi's retain-on-failure design, not a swallow).
      const response = await fetchImpl(`${base}/models`, { signal: context.signal });
      if (!response.ok) {
        throw new Error(`llama-swap answered ${response.status ?? "an error"} at ${base}/models`);
      }
      const body: unknown = await response.json();
      const data = typeof body === "object" && body !== null ? (body as Record<string, unknown>).data : undefined;
      if (!Array.isArray(data)) {
        throw new Error("llama-swap /models did not return a data array");
      }
      return data
        .map((entry) => catalogModel(entry, configured, endpoint))
        .filter((candidate): candidate is Model<"openai-completions"> => candidate !== undefined);
    },
    api: openAICompletionsApi(),
  });
}

/** A pi-ai registry with the configured provider set. */
export function configuredModels(config: GlobalConfig, model: ModelRef, deps: LlamaSwapDeps = {}): Models {
  const models = createModels();
  models.setProvider(modelsForConfig(config, model, deps));
  return models;
}
