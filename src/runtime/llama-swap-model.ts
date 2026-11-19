import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

import type { GlobalConfig, ModelRef } from "./config.js";

export const LLAMA_SWAP_PROVIDER_ID = "llama-swap";

/**
 * Make the configured llama-swap model available to Pi.
 * llama.cpp accepts system messages but not OpenAI's developer role or reasoning_effort.
 */
export function modelsForConfig(config: GlobalConfig, model: ModelRef) {
  if (model.provider !== LLAMA_SWAP_PROVIDER_ID) return undefined;
  if (config.llamaSwapEndpoint === undefined) {
    throw new Error("A llama-swap model needs llamaSwapEndpoint in Mini configuration.");
  }

  const models = createModels();
  models.setProvider(
    createProvider({
      id: LLAMA_SWAP_PROVIDER_ID,
      name: "llama-swap",
      baseUrl: config.llamaSwapEndpoint,
      auth: {
        apiKey: {
          name: "Keyless llama-swap server",
          // Pi's OpenAI client needs a non-empty internal value. The null header
          // removes the resulting Authorization header before the request leaves.
          resolve: async () => ({ auth: { apiKey: "unused", headers: { authorization: null } } }),
        },
      },
      models: [
        {
          id: model.modelId,
          name: model.modelId,
          api: "openai-completions",
          provider: LLAMA_SWAP_PROVIDER_ID,
          baseUrl: config.llamaSwapEndpoint,
          contextWindow: 32_768,
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
    }),
  );
  return models;
}
