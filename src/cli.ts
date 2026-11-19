import { access } from "node:fs/promises";
import { parseArgs } from "node:util";

import { ConfigError, loadGlobalConfig } from "./runtime/config.js";
import { brainDatabasePath, projectRoot } from "./runtime/paths.js";

function usage(): string {
  return [
    "Usage: carto [project-path] [--model provider/model] [--help]",
    "",
    "Mini reads its global configuration from ~/.carto/config.json.",
    "The first --model value creates that file.",
  ].join("\n");
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      model: { type: "string", short: "m" },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (parsed.positionals.length > 1) throw new ConfigError("Use zero or one project path.");

  const config = await loadGlobalConfig(
    parsed.values.model === undefined ? {} : { modelOverride: parsed.values.model },
  );
  const root = projectRoot(parsed.positionals[0]);
  let initialized = true;
  try {
    await access(brainDatabasePath(root));
  } catch {
    initialized = false;
  }

  process.stdout.write("Cartographer Mini\n");
  process.stdout.write(`Project: ${root}\n`);
  process.stdout.write(`Model: ${config.model}\n`);
  process.stdout.write(`Collapse mode: ${config.collapseMode}\n`);
  process.stdout.write(initialized ? "Brain: ready\n" : "Brain: not initialized\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`carto: ${message}\n`);
  process.exitCode = 1;
});
