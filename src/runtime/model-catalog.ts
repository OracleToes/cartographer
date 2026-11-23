/**
 * Provider-backed model indexing and lookup.
 *
 * Reads the models exposed by every registered provider in Pi's `Models`
 * catalog (for example `llama-swap`'s `/v1/models` listing), optionally
 * refreshing from the provider first without failing the caller when the
 * server is unreachable.
 */
import type { Models } from "@earendil-works/pi-ai/models";

import type { ModelRef } from "./config.js";

export interface IndexedModel {
  readonly provider: string;
  readonly modelId: string;
  readonly contextWindow: number;
  readonly active: boolean;
}

export interface ProviderIndexError {
  readonly provider: string;
  readonly message: string;
}

export interface IndexedModelsResult {
  readonly models: IndexedModel[];
  readonly errors: ProviderIndexError[];
}

export function formatModelRef(model: ModelRef): string {
  return `${model.provider}/${model.modelId}`;
}

/** Snapshot every chat model currently in the `Models` catalog, sorted cleanly. */
export function listIndexedModels(models: Models, active?: ModelRef): IndexedModel[] {
  const seen = new Set<string>();
  const indexed: IndexedModel[] = [];
  for (const model of models.getModels()) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    indexed.push({
      provider: model.provider,
      modelId: model.id,
      contextWindow: model.contextWindow,
      active: active !== undefined && model.provider === active.provider && model.id === active.modelId,
    });
  }
  indexed.sort((a, b) => {
    const byProvider = a.provider.localeCompare(b.provider, "en", { sensitivity: "base" });
    if (byProvider !== 0) return byProvider;
    return a.modelId.localeCompare(b.modelId, "en", { sensitivity: "base" });
  });
  return indexed;
}

/**
 * Optionally refresh every registered provider in `models`, then return the
 * indexed list along with any per-provider refresh errors.
 */
export async function indexModels(
  models: Models,
  options: { refresh?: boolean; force?: boolean; active?: ModelRef; signal?: AbortSignal } = {},
): Promise<IndexedModelsResult> {
  const errors: ProviderIndexError[] = [];
  if (options.refresh === true) {
    const providers = models.getProviders().map((provider) => provider.id);
    if (providers.length > 0) {
      try {
        const result = await models.refresh({
          providers,
          force: options.force ?? true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        for (const [provider, error] of result.errors.entries()) {
          errors.push({
            provider,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      } catch (error) {
        errors.push({
          provider: providers.join(", "),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return {
    models: listIndexedModels(models, options.active),
    errors,
  };
}

/**
 * Resolve a typed model reference (`provider/modelId` or bare `modelId`)
 * against the currently indexed catalog. Returns `undefined` when nothing
 * matches or when a bare id is ambiguous across multiple providers.
 */
export function resolveIndexedModel(
  models: Models,
  spec: string,
  defaultProvider?: string,
): ModelRef | undefined {
  const trimmed = spec.trim();
  if (trimmed.length === 0) return undefined;

  // Exact `provider/modelId` match (model ids may themselves contain `/`).
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = trimmed.slice(0, slash);
    const modelId = trimmed.slice(slash + 1);
    const exact = models.getModel(provider, modelId);
    if (exact !== undefined) return { provider: exact.provider, modelId: exact.id };
  }

  // Exact bare `modelId` match (handles ids that themselves contain `/` like `org/model`).
  const all = models.getModels();
  const matches = all.filter((candidate) => candidate.id === trimmed);
  if (matches.length === 1) {
    return { provider: matches[0]!.provider, modelId: matches[0]!.id };
  }
  if (matches.length > 1 && defaultProvider !== undefined) {
    const preferred = matches.find((candidate) => candidate.provider === defaultProvider);
    if (preferred !== undefined) return { provider: preferred.provider, modelId: preferred.id };
  }

  // Case-insensitive exact fallback on `provider/modelId` or bare `modelId`.
  const lower = trimmed.toLowerCase();
  const ciFull = all.filter((candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === lower);
  if (ciFull.length === 1) return { provider: ciFull[0]!.provider, modelId: ciFull[0]!.id };
  const ciId = all.filter((candidate) => candidate.id.toLowerCase() === lower);
  if (ciId.length === 1) return { provider: ciId[0]!.provider, modelId: ciId[0]!.id };
  if (ciId.length > 1 && defaultProvider !== undefined) {
    const preferred = ciId.find((candidate) => candidate.provider === defaultProvider);
    if (preferred !== undefined) return { provider: preferred.provider, modelId: preferred.id };
  }

  return undefined;
}
