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

const STATUS = "carto opens the workspace TUI on a terminal; --headless runs the line driver instead.";

function usage(): string {
  return [
    "Usage: carto [--help] [--model <provider/modelId>] [--endpoint <url>] [--context-window <n>] [--root <dir>] [--headless]",
    "",
    "Configuration lives in ~/.carto/config.json (override the directory with CARTO_HOME).",
    "The endpoint in that file is where your llama.cpp server serves, through llama-swap;",
    "llama-swap advertises a model's capacity once it has loaded, and Carto uses that as the",
    "window. --context-window pins the window instead and always wins.",
    "",
    "Options:",
    "  --model <provider/modelId>  Model to use, e.g. llama-swap/ByteShape. Writes the config",
    "                              file when it is missing; applies in memory otherwise.",
    "                              Only the keyless llama-swap provider is wired in this build.",
    "  --endpoint <url>            The llama-swap OpenAI-compatible base URL,",
    "                              e.g. http://localhost:8888/v1.",
    "  --context-window <n>        Pin the context window (integer ≥ 0), and it always wins — it",
    "                              can raise the server's number. Without it, the advertised",
    "                              capacity is used and is unknown until the model loads.",
    "  --root <dir>                Project root holding .brain/. Default: the current directory.",
    "  --headless                  Run the line driver instead of the workspace.",
    "  -h, --help                  Show this help.",
    "",
    "Quick start (ByteShape, port 8888, 75k window):",
    "  carto --model llama-swap/ByteShape --endpoint http://localhost:8888/v1 --context-window 75000",
    "",
    "In the workspace, the agent's words reach you through its chat tool and nothing else:",
    "  f1          every key there is, where the cursor is; the footer lists the ones that matter now",
    "  ctrl+p      the palette — every command, searchable, with its key",
    "  ctrl+o      jump to a view · ctrl+x stop the run · shift+tab send mode (steer / after run / now)",
    "  ctrl+t      swap between the context layer and the archive layer · ctrl+h sidebar · ctrl+c quit",
    "",
    "Line driver commands:",
    "  /collapse   collapse the context now — the Brain rebuilds it",
    "  /help       the commands · /quit  end the session",
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
