/**
 * The llama-swap provider (MINI.md §11 — Pi AI owns the provider layer).
 * Rewritten fresh for the rebuild, informed by main's documented approach:
 *
 * - keyless: llama-swap serves keyless llama.cpp locally; Pi's OpenAI client
 *   needs a non-empty internal value, and the `authorization: null` header
 *   removes the resulting Authorization header before the request leaves;
 * - OpenAI-compatible `/v1` endpoint, openAI-completions API;
 * - llama.cpp accepts system messages but not the developer role,
 *   reasoning_effort, store, or streamed usage; max_tokens field, not
 *   max_completion_tokens;
 * - the context window is `min(configured ceiling, advertised capacity)`;
 *   before the model loads nothing is advertised and the ceiling rules.
 *
 * Not brought over from main: GBNF/native enforcement, /consult probes,
 * prefill-progress plumbing, settings UI. Those are main's rig, not the spec.
 */
import { createModels, createProvider, type Models, type Provider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import { ConfigError, type GlobalConfig, type ModelRef } from "./config.js";
import { activeContextWindow, type AdvertisedCapacity } from "./capacity.js";

export const LLAMA_SWAP_PROVIDER_ID = "llama-swap";

/** Used only when the config names no contextWindow; the active window is reported either way. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

export function modelsForConfig(config: GlobalConfig, model: ModelRef, advertised?: AdvertisedCapacity): Provider {
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

  const contextWindow = activeContextWindow(config.contextWindow ?? DEFAULT_CONTEXT_WINDOW, advertised?.capacity);
  const endpoint = config.llamaSwapEndpoint;
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
    models: [
      {
        id: model.modelId,
        name: model.modelId,
        api: "openai-completions",
        provider: LLAMA_SWAP_PROVIDER_ID,
        baseUrl: endpoint,
        contextWindow,
        maxTokens: 4_096,
        input: ["text"],
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsStore: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
      },
    ],
    api: openAICompletionsApi(),
  });
}

/** A pi-ai registry with the configured provider set. */
export function configuredModels(config: GlobalConfig, model: ModelRef, advertised?: AdvertisedCapacity): Models {
  const models = createModels();
  models.setProvider(modelsForConfig(config, model, advertised));
  return models;
}
