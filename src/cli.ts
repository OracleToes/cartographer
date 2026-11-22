/**
 * carto — the entry point.
 *
 * On a TTY, carto boots the workspace TUI (§8). Off a TTY — piped stdin, CI — it runs
 * the line driver instead, where the only words the person sees are the
 * agent's `chat` tool calls. `--headless` forces the line driver.
 */

import { parseArgs } from "node:util";

import { openBrain } from "./runtime/brain-store.js";
import { brainDatabasePath, resolveProjectRoot } from "./runtime/paths.js";
import { loadGlobalConfig, parseModelRef, ConfigError } from "./runtime/config.js";
import { configuredModels } from "./runtime/llama-swap-model.js";
import { runHeadless } from "./runtime/headless.js";
import { runTui } from "./ui/app.js";

const STATUS = [
  "carto boots the workspace TUI on a terminal; --headless runs the line driver.",
  "The Context surgery view and the Brain views land in their own slices.",
].join("\n");

function usage(): string {
  return [
    "Usage: carto [--help] [--model <provider/modelId>] [--endpoint <url>] [--context-window <n>] [--root <dir>] [--headless]",
    "",
    "Reads its global configuration from ~/.carto/config.json (override the directory",
    "with CARTO_HOME). The llama-swap endpoint in that file is where your llama.cpp",
    "server serves; llama-swap advertises the model's true capacity only once it has",
    "loaded, and Carto uses its advertised capacity as the window. The --context-window",
    "flag pins the window and always wins (even above advertised). Without either,",
    "the window is unknown until the model loads.",
    "",
    "Options:",
    "  --model <provider/modelId>  Model to use, e.g. llama-swap/ByteShape. Creates the",
    "                              config file when missing; applied in memory otherwise.",
    "                              Only the keyless llama-swap provider is wired in this build.",
    "  --endpoint <url>            The llama-swap OpenAI-compatible base URL,",
    "                              e.g. http://localhost:8888/v1.",
    "  --context-window <n>        Pin the context window (integer ≥ 0). It always wins — it can raise the server's number;",
    "                              without it, the server's advertised capacity is used (unknown until the model loads).",
    "  --root <dir>                Project root holding .brain/. Default: the current directory.",
    "  --headless                  Run the line driver instead of the TUI.",
    "  -h, --help                  Show this help.",
    "",
    "Quick start (ByteShape, port 8888, 75k window):",
    "  carto --model llama-swap/ByteShape --endpoint http://localhost:8888/v1 --context-window 75000",
    "",
    "With a terminal attached, carto boots the workspace; the agent's words reach you through the chat tool only.",
    "  ctrl+x      stop the run now · shift+tab cycles the send mode (steer / after run / now)",
    "  ctrl+o      jump mode · ctrl+p command palette · ctrl+h sidebar · ctrl+c quit",
    "  /help       (TUI) list the in-workspace commands — /copy, /copy-session",
    "  /collapse   (headless) collapse the context now (the Brain rebuilds it)",
    "  /quit       (headless) end the session",
    "  --headless  force the line driver even on a terminal",
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
    headless: { type: "boolean" },
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
    if (!Number.isInteger(parsedNumber) || parsedNumber < 0) {
      throw new ConfigError(`--context-window must be an integer of at least 0 (0 = no pin — the server's advertised window, or unknown); got "${values["context-window"]}".`);
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
  const brain = await openBrain(brainDatabasePath(root));
  if (created) {
    process.stderr.write(`carto: wrote ${configPath} (model ${config.model})\n`);
  }

  const models = configuredModels(config, model);
  const refreshCapacity = config.llamaSwapEndpoint === undefined ? undefined : true;

  const stdinIsTty = (process.stdin as { isTTY?: boolean }).isTTY === true;
  const code = values.headless === true || !stdinIsTty
    ? await runHeadless({
        root,
        brain,
        models,
        model,
        input: process.stdin,
        output: process.stdout,
        error: process.stderr,
        ...(refreshCapacity === undefined ? {} : { refreshCapacity }),
      })
    : await runTui({
        root,
        brain,
        models,
        model,
        ...(refreshCapacity === undefined ? {} : { refreshCapacity }),
      });
  await brain.close();
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
