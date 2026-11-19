import { parseArgs } from "node:util";

import { ConfigError, loadGlobalConfig } from "./runtime/config.js";
import { brainDatabasePath, projectRoot } from "./runtime/paths.js";

function usage(): string {
  return [
    "Usage: carto [project-path] [--model provider/model] [--endpoint http://host:port/v1] [--import-legacy] [--help]",
    "",
    "Carto reads its global configuration from ~/.carto/config.json.",
    "The first --model value creates that file.",
    "Use --model llama-swap/Flint --endpoint http://localhost:8888/v1 for llama-swap or llama-server.",
    "--endpoint is valid only with a llama-swap/model model. It does not store an API key.",
    "--import-legacy copies old plain JSON Atlas and Ledger records from <project>/.brain/ and then exits.",
  ].join("\n");
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string", short: "m" },
      endpoint: { type: "string", short: "e" },
      "import-legacy": { type: "boolean" },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.positionals.length > 1) throw new ConfigError("Use zero or one project path.");
  const root = projectRoot(parsed.positionals[0]);

  if (parsed.values["import-legacy"]) {
    if (parsed.values.model !== undefined || parsed.values.endpoint !== undefined) {
      throw new ConfigError("Use --import-legacy, --model, and --endpoint in separate starts.");
    }
    const { readLegacyBrain, importLegacyBrain } = await import("./runtime/legacy-import.js");
    const legacy = await readLegacyBrain(root);
    const { BrainStore } = await import("./runtime/brain-store.js");
    const brain = await BrainStore.open(brainDatabasePath(root));
    try {
      const result = await importLegacyBrain(brain, legacy);
      process.stdout.write(`Imported ${result.ledger} Ledger record(s) and ${result.atlas} Atlas record(s).\n`);
      for (const warning of result.warnings) process.stdout.write(`Warning: ${warning}\n`);
    } finally {
      await brain.close();
    }
    return;
  }

  const config = await loadGlobalConfig({
    ...(parsed.values.model === undefined ? {} : { modelOverride: parsed.values.model }),
    ...(parsed.values.endpoint === undefined ? {} : { llamaSwapEndpointOverride: parsed.values.endpoint }),
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ConfigError("carto needs an interactive terminal for the Carto UI.");
  }
  const [{ CartoProject }, { runCartoUi }] = await Promise.all([
    import("./runtime/project.js"),
    import("./runtime/ui.js"),
  ]);
  const project = await CartoProject.open(root, config);
  try {
    await runCartoUi(project);
  } finally {
    await project.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`carto: ${message}\n`);
  process.exitCode = 1;
});
