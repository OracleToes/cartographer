/**
 * Global configuration (`~/.carto/config.json`).
 *
 * The file names the model and, for llama-swap, where it serves and the
 * window Carto should use. The llama-swap server advertises the model's true
 * capacity only after it loads; the configured `contextWindow` always wins —
 * it is a hard override, not a ceiling, and may raise the server's number.
 * With no `contextWindow`, the advertised capacity is the truth, or unknown
 * until the server speaks.
 *
 * No keys: llama-swap is keyless (main's documented approach, rewritten
 * fresh). Other providers are not wired in this build and say so plainly.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { cartoConfigPath, cartoHome } from "./paths.js";

export interface GlobalConfig {
  version: 1;
  /** "provider/modelId", e.g. "llama-swap/ByteShape". Model ids may themselves contain "/". */
  model: string;
  /** The OpenAI-compatible base URL of the llama-swap server, e.g. "http://localhost:8888/v1". */
  llamaSwapEndpoint?: string;
  /** The pinned context window: it always wins (it can raise the server's advertised capacity). Unset: the server's advertised capacity is used. */
  contextWindow?: number;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** "provider/modelId" — splits on the first "/"; the model id keeps the rest. */
export function parseModelRef(spec: string): ModelRef {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new ConfigError(`A model must look like "provider/modelId" (e.g. "llama-swap/ByteShape"); got "${spec}".`);
  }
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function parseContextWindow(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${where}: contextWindow must be an integer of at least 0 (0 = no pin — the server's advertised window, or unknown); got ${JSON.stringify(value)}.`);
  }
  return value;
}

function parseEndpoint(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ConfigError(`${where}: llamaSwapEndpoint must be a string URL; got ${typeof value}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${where}: llamaSwapEndpoint is not a valid URL: "${value}".`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${where}: llamaSwapEndpoint must be http(s); got "${url.protocol}".`);
  }
  return value.replace(/\/+$/, "");
}

export function parseConfig(input: unknown, where = "config.json"): GlobalConfig {
  if (typeof input !== "object" || input === null) {
    throw new ConfigError(`${where}: expected a JSON object.`);
  }
  const record = input as Record<string, unknown>;
  if (record.version !== 1) {
    throw new ConfigError(`${where}: version must be 1; got ${JSON.stringify(record.version)}.`);
  }
  if (typeof record.model !== "string") {
    throw new ConfigError(`${where}: model must be a string like "llama-swap/ByteShape".`);
  }
  parseModelRef(record.model); // validates shape
  const llamaSwapEndpoint = parseEndpoint(record.llamaSwapEndpoint, where);
  const contextWindow = parseContextWindow(record.contextWindow, where);
  return {
    version: 1,
    model: record.model,
    ...(llamaSwapEndpoint === undefined ? {} : { llamaSwapEndpoint }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

async function saveTo(path: string, config: GlobalConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function saveGlobalConfig(config: GlobalConfig, home: string = cartoHome()): Promise<string> {
  const path = cartoConfigPath(home);
  await saveTo(path, parseConfig(config, path));
  return path;
}

export interface LoadOptions {
  home?: string;
  /** "provider/modelId"; creates the file when missing, applied in memory otherwise. */
  modelOverride?: string;
  /** Applies in memory; written to disk only when the file is being created. */
  llamaSwapEndpointOverride?: string;
  /** Applies in memory; written to disk only when the file is being created. */
  contextWindowOverride?: number;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Load the global config. When it is missing and a model override is given,
 * the file is created from the overrides. When it is missing and no model is
 * given, the error says exactly how to create it.
 */
export async function loadGlobalConfig(options: LoadOptions = {}): Promise<{ config: GlobalConfig; path: string; created: boolean }> {
  const home = options.home ?? cartoHome(options.environment);
  const path = cartoConfigPath(home);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      throw new ConfigError(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (options.modelOverride === undefined) {
      throw new ConfigError(
        `No Carto configuration exists at ${path}.\n` +
          `Create it with: carto --model llama-swap/ByteShape --endpoint http://localhost:8888/v1 --context-window 75000`,
      );
    }
    const config = parseConfig(
      {
        version: 1,
        model: options.modelOverride,
        ...(options.llamaSwapEndpointOverride === undefined ? {} : { llamaSwapEndpoint: options.llamaSwapEndpointOverride }),
        ...(options.contextWindowOverride === undefined ? {} : { contextWindow: options.contextWindowOverride }),
      },
      path,
    );
    await saveTo(path, config);
    return { config, path, created: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  const config = parseConfig(parsed, path);
  const endpoint = options.llamaSwapEndpointOverride === undefined ? undefined : parseEndpoint(options.llamaSwapEndpointOverride, "--endpoint");
  const contextWindow = options.contextWindowOverride === undefined ? undefined : parseContextWindow(options.contextWindowOverride, "--context-window");
  const merged: GlobalConfig = { version: 1, model: config.model };
  const llamaSwapEndpoint = endpoint ?? config.llamaSwapEndpoint;
  const effectiveWindow = contextWindow ?? config.contextWindow;
  if (llamaSwapEndpoint !== undefined) merged.llamaSwapEndpoint = llamaSwapEndpoint;
  if (effectiveWindow !== undefined) merged.contextWindow = effectiveWindow;
  return { config: merged, path, created: false };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
