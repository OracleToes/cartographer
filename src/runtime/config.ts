import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cartoConfigPath, cartoHome } from "./paths.js";

export type CollapseMode = "request" | "agent";

export interface GlobalConfig {
  version: 1;
  model: string;
  collapseMode: CollapseMode;
  /** The OpenAI-compatible endpoint used only by llama-swap. */
  llamaSwapEndpoint?: string;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

export class ConfigError extends Error {}

export async function loadGlobalConfig(options: {
  home?: string;
  modelOverride?: string;
  llamaSwapEndpointOverride?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): Promise<GlobalConfig> {
  const home = options.home ?? cartoHome(options.environment);
  const path = cartoConfigPath(home);

  let input: unknown;
  try {
    input = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    if (options.modelOverride === undefined) {
      throw new ConfigError(`No Mini configuration exists at ${path}. Run carto --model provider/model once.`);
    }
    const config = parseConfig({
      version: 1,
      model: options.modelOverride,
      collapseMode: "request",
      ...(options.llamaSwapEndpointOverride === undefined ? {} : { llamaSwapEndpoint: options.llamaSwapEndpointOverride }),
    });
    await saveGlobalConfig(config, home);
    return config;
  }

  try {
    return applyOverrides(parseConfig(input), options);
  } catch (error) {
    const recovered = recoverLegacyEndpointModelConfig(input, options);
    if (recovered === undefined) throw error;
    await saveGlobalConfig(recovered, home);
    return recovered;
  }
}

export async function saveGlobalConfig(config: GlobalConfig, home = cartoHome()): Promise<void> {
  const path = cartoConfigPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parseConfig(config), null, 2)}\n`, "utf8");
}

export function parseModelRef(value: string): ModelRef {
  if (value.trim() !== value || value.includes("://") || /[\s\[\](){}]/.test(value)) {
    throw new ConfigError("A model is provider/model. Do not put an endpoint URL in --model.");
  }
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) {
    throw new ConfigError("A model must use provider/model format.");
  }
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

export function parseConfig(value: unknown): GlobalConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError("Mini configuration must be a JSON object.");
  }
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new ConfigError("Mini configuration version must be 1.");
  if (typeof input.model !== "string") throw new ConfigError("Mini configuration needs a model.");
  if (input.collapseMode !== "request" && input.collapseMode !== "agent") {
    throw new ConfigError("Mini configuration collapseMode must be request or agent.");
  }

  const model = validateModel(input.model);
  const provider = parseModelRef(model).provider;
  const llamaSwapEndpoint = input.llamaSwapEndpoint === undefined ? undefined : validateLlamaSwapEndpoint(input.llamaSwapEndpoint);
  if (provider === "llama-swap" && llamaSwapEndpoint === undefined) {
    throw new ConfigError("A llama-swap model needs llamaSwapEndpoint in Mini configuration or --endpoint on this start.");
  }
  if (provider !== "llama-swap" && llamaSwapEndpoint !== undefined) {
    throw new ConfigError("llamaSwapEndpoint is valid only with a llama-swap/model value.");
  }
  return llamaSwapEndpoint === undefined
    ? { version: 1, model, collapseMode: input.collapseMode }
    : { version: 1, model, collapseMode: input.collapseMode, llamaSwapEndpoint };
}

function applyOverrides(
  config: GlobalConfig,
  options: Pick<{ modelOverride?: string; llamaSwapEndpointOverride?: string }, "modelOverride" | "llamaSwapEndpointOverride">,
): GlobalConfig {
  const model = options.modelOverride ?? config.model;
  const currentProvider = parseModelRef(config.model).provider;
  const provider = parseModelRef(model).provider;
  const llamaSwapEndpoint =
    options.llamaSwapEndpointOverride ?? (provider === "llama-swap" && currentProvider === "llama-swap" ? config.llamaSwapEndpoint : undefined);
  return parseConfig({
    version: 1,
    model,
    collapseMode: config.collapseMode,
    ...(llamaSwapEndpoint === undefined ? {} : { llamaSwapEndpoint }),
  });
}

function recoverLegacyEndpointModelConfig(
  value: unknown,
  options: Pick<{ modelOverride?: string; llamaSwapEndpointOverride?: string }, "modelOverride" | "llamaSwapEndpointOverride">,
): GlobalConfig | undefined {
  if (options.modelOverride === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  if (
    input.version !== 1 ||
    (input.collapseMode !== "request" && input.collapseMode !== "agent") ||
    typeof input.model !== "string" ||
    !input.model.includes("://")
  ) {
    return undefined;
  }
  return parseConfig({
    version: 1,
    model: options.modelOverride,
    collapseMode: input.collapseMode,
    ...(options.llamaSwapEndpointOverride === undefined ? {} : { llamaSwapEndpoint: options.llamaSwapEndpointOverride }),
  });
}

function validateModel(value: string): string {
  parseModelRef(value);
  return value;
}

function validateLlamaSwapEndpoint(value: unknown): string {
  if (typeof value !== "string") throw new ConfigError("llamaSwapEndpoint must be an http or https URL.");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ConfigError("llamaSwapEndpoint must be an http or https URL.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new ConfigError("llamaSwapEndpoint must use http or https.");
  }
  if (endpoint.username !== "" || endpoint.password !== "" || endpoint.search !== "" || endpoint.hash !== "") {
    throw new ConfigError("llamaSwapEndpoint must not include credentials, a query, or a fragment.");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/";
  return endpoint.pathname === "/" ? endpoint.origin : endpoint.toString();
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
