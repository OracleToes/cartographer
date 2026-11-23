/**
 * carto — the entry point.
 *
 * On a TTY, carto boots the workspace TUI (§8). Off a TTY — piped stdin, CI — it runs
 * the line driver instead, where the only words the person sees are the
 * agent's `chat` tool calls. `--headless` forces the line driver.
 */

import { parseArgs } from "node:util";

import { brainDatabasePath, resolveProjectRoot } from "./runtime/paths.js";
import { loadGlobalConfig, parseModelRef, ConfigError } from "./runtime/config.js";
import { personName } from "./domain/person.js";
import { COLLAPSE_WARNING_PERCENT } from "./domain/state-block.js";

const STATUS = "carto opens the workspace TUI on a terminal; --headless runs the line driver instead.";

function usage(): string {
  return [
    "Usage: carto [--help] [--model <provider/modelId>] [--endpoint <url>] [--context-window <n>] [--collapse-warning <n>] [--user <name>] [--root <dir>] [--headless]",
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
    "  --collapse-warning <n>      Context fill percentage (1–100, default 75) that triggers",
    "                              [COLLAPSE NEEDED] in the state block (config: \"collapseWarningPercent\").",
    "  --user <name>               What the agent calls you. Default: the account that launched",
    "                              Carto (config: \"userName\").",
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
    "  ctrl+t      swap between the context layer and the archive layer · ctrl+h sidebar",
    "  ctrl+v      pause the run and hold it mid-reply · ctrl+g write the message in $EDITOR",
    "  ctrl+c      clear the line, or press it twice on an empty line to leave",
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
    "collapse-warning": { type: "string" },
    user: { type: "string" },
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

  let collapseWarningPercent: number | undefined;
  if (values["collapse-warning"] !== undefined) {
    const raw = values["collapse-warning"].trim();
    const parsedNumber = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isInteger(parsedNumber) || parsedNumber < 1 || parsedNumber > 100) {
      throw new ConfigError(`--collapse-warning must be an integer from 1 to 100 (default ${COLLAPSE_WARNING_PERCENT}); got "${values["collapse-warning"]}".`);
    }
    collapseWarningPercent = parsedNumber;
  }

  const { config, path: configPath, created } = await loadGlobalConfig({
    ...(values.model === undefined ? {} : { modelOverride: values.model }),
    ...(values.endpoint === undefined ? {} : { llamaSwapEndpointOverride: values.endpoint }),
    ...(contextWindow === undefined ? {} : { contextWindowOverride: contextWindow }),
    ...(collapseWarningPercent === undefined ? {} : { collapseWarningPercentOverride: collapseWarningPercent }),
    ...(values.user === undefined ? {} : { userNameOverride: values.user }),
  });
  const model = parseModelRef(config.model);
  // One resolution, at the entry point, so the TUI, the line driver, the tool
  // descriptions and the state block all name the same person.
  const person = personName(config.userName);

  // Help and configuration errors do not need the durable runtime, model
  // providers, or terminal UI. Load those only once a session is requested.
  const { openBrain } = await import("./runtime/brain-store.js");
  const root = resolveProjectRoot(values.root);
  const brain = await openBrain(brainDatabasePath(root));
  if (created) {
    process.stderr.write(`carto: wrote ${configPath} (model ${config.model})\n`);
  }

  const { configuredModels } = await import("./runtime/llama-swap-model.js");
  const models = configuredModels(config, model);
  const refreshCapacity = config.llamaSwapEndpoint === undefined ? undefined : true;

  const stdinIsTty = (process.stdin as { isTTY?: boolean }).isTTY === true;
  const code = values.headless === true || !stdinIsTty
    ? await (await import("./runtime/headless.js")).runHeadless({
        root,
        brain,
        models,
        model,
        input: process.stdin,
        output: process.stdout,
        error: process.stderr,
        person,
        ...(config.collapseWarningPercent === undefined ? {} : { collapseWarningPercent: config.collapseWarningPercent }),
        ...(refreshCapacity === undefined ? {} : { refreshCapacity }),
      })
    : await (await import("./ui/app.js")).runTui({
        root,
        brain,
        models,
        model,
        person,
        ...(config.collapseWarningPercent === undefined ? {} : { collapseWarningPercent: config.collapseWarningPercent }),
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
