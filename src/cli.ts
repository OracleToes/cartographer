/**
 * carto — placeholder entry point (MINI.md §8 is the person's to mark).
 *
 * This build has no screen. The supported invocation is the headless driver:
 * a line-based loop on stdin/stdout where the only words the person sees are
 * the agent's `chat` tool calls. Placeholder slash commands: /help, /collapse,
 * /quit. The configuration below is real; the interface is not.
 */

import { parseArgs } from "node:util";

import { openBrain } from "./runtime/brain-store.js";
import { brainDatabasePath, resolveProjectRoot } from "./runtime/paths.js";
import { loadGlobalConfig, parseModelRef, ConfigError } from "./runtime/config.js";
import { configuredModels } from "./runtime/llama-swap-model.js";
import { runHeadless } from "./runtime/headless.js";

const STATUS = [
  "carto is being rebuilt from its specification (MINI.md).",
  "This build has no screen yet; the line-based stdin driver below is a placeholder, not the designed interface.",
].join("\n");

function usage(): string {
  return [
    "Usage: carto [--help] [--model <provider/modelId>] [--endpoint <url>] [--context-window <n>] [--root <dir>]",
    "",
    "Reads its global configuration from ~/.carto/config.json (override the directory",
    "with CARTO_HOME). The llama-swap endpoint in that file is where your llama.cpp",
    "server serves; llama-swap advertises the model's true capacity only once it has",
    "loaded, and Carto drops the active context limit to min(configured, advertised)",
    "at that point. It never raises the configured ceiling on its own.",
    "",
    "Options:",
    "  --model <provider/modelId>  Model to use, e.g. llama-swap/ByteShape. Creates the",
    "                              config file when missing; applied in memory otherwise.",
    "                              Only the keyless llama-swap provider is wired in this build.",
    "  --endpoint <url>            The llama-swap OpenAI-compatible base URL,",
    "                              e.g. http://localhost:8888/v1.",
    "  --context-window <n>        Ceiling on the active context window (integer ≥ 1024).",
    "  --root <dir>                Project root holding .brain/. Default: the current directory.",
    "  -h, --help                  Show this help.",
    "",
    "Quick start (ByteShape, port 8888, 75k window):",
    "  carto --model llama-swap/ByteShape --endpoint http://localhost:8888/v1 --context-window 75000",
    "",
    "Then type lines; Carto works, and its words to you come through the chat tool only.",
    "  /collapse   collapse the context now (the Brain rebuilds it)",
    "  /quit       end the session",
    "",
    STATUS,
  ].join("\n");
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    help: { type: "boolean", short: "h" },
    model: { type: "string" },
    endpoint: { type: "string" },
    "context-window": { type: "string" },
    root: { type: "string" },
  },
  allowPositionals: false,
});

const values = parsed.values;

if (values.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

try {
  let contextWindow: number | undefined;
  if (values["context-window"] !== undefined) {
    const parsedNumber = Number(values["context-window"]);
    if (!Number.isInteger(parsedNumber) || parsedNumber < 1_024) {
      throw new ConfigError(`--context-window must be an integer of at least 1024; got "${values["context-window"]}".`);
    }
    contextWindow = parsedNumber;
  }

  const { config, path: configPath, created } = await loadGlobalConfig({
    ...(values.model === undefined ? {} : { modelOverride: values.model }),
    ...(values.endpoint === undefined ? {} : { llamaSwapEndpointOverride: values.endpoint }),
    ...(contextWindow === undefined ? {} : { contextWindowOverride: contextWindow }),
  });
  const model = parseModelRef(config.model);

  const root = resolveProjectRoot(values.root);
  const brain = openBrain(brainDatabasePath(root));
  if (created) {
    process.stderr.write(`carto: wrote ${configPath} (model ${config.model})\n`);
  }

  const models = configuredModels(config, model);
  const refreshCapacity = config.llamaSwapEndpoint === undefined ? undefined : true;

  const code = await runHeadless({
    root,
    brain,
    models,
    model,
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
    ...(refreshCapacity === undefined ? {} : { refreshCapacity }),
  });
  brain.close();
  process.exitCode = code;
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`carto: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`carto: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
