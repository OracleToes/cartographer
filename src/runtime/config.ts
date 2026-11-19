import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cartoConfigPath, cartoHome } from "./paths.js";

export type CollapseMode = "request" | "agent";

export interface GlobalConfig {
  version: 1;
  model: string;
  collapseMode: CollapseMode;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

export class ConfigError extends Error {}

export async function loadGlobalConfig(options: {
  home?: string;
  modelOverride?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): Promise<GlobalConfig> {
  const home = options.home ?? cartoHome(options.environment);
  const path = cartoConfigPath(home);
  const override = options.modelOverride;

  try {
    const config = parseConfig(JSON.parse(await readFile(path, "utf8")));
    return override === undefined ? config : { ...config, model: validateModel(override) };
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    if (override === undefined) {
      throw new ConfigError(`No Mini configuration exists at ${path}. Run carto --model provider/model once.`);
    }
    const config: GlobalConfig = { version: 1, model: validateModel(override), collapseMode: "request" };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return config;
  }
}

export async function saveGlobalConfig(config: GlobalConfig, home = cartoHome()): Promise<void> {
  const path = cartoConfigPath(home);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parseConfig(config), null, 2)}\n`, "utf8");
}

export function parseModelRef(value: string): ModelRef {
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
  return { version: 1, model: validateModel(input.model), collapseMode: input.collapseMode };
}

function validateModel(value: string): string {
  parseModelRef(value);
  return value;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
