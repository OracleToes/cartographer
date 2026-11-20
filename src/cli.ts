import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";

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
    "",
    "With no other arguments, carto runs the agent headlessly: each line of stdin",
    "is one person message, and the agent's Chat records are printed to stdout as",
    "the turn finishes. EOF or Ctrl-C ends the session. There is no interface yet;",
    "this driver exists so the agent can run while the screen is rebuilt.",
  ].join("\n");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  const [{ CartoProject }] = await Promise.all([import("./runtime/project.js")]);
  const project = await CartoProject.open(root, config);
  try {
    await runHeadless(project);
  } finally {
    await project.close();
  }
}

/**
 * The headless driver: each stdin line is one person message, answered as a
 * follow-up turn. When the turn settles, the agent's new Chat records are
 * printed to stdout, one per line. A silent turn means the agent had nothing
 * to say to the person. Prompts and diagnostics go to stderr; stdout carries
 * Chat only.
 */
async function runHeadless(project: import("./runtime/project.js").CartoProject): Promise<void> {
  const seen = new Set<string>();
  for (const record of (await project.view()).brain.chat) seen.add(record.id);

  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      process.stderr.write("carto: Ctrl-C again to exit immediately.\n");
      rl.close();
      return;
    }
    process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (text === "") continue;
      const generationBefore = project.liveGeneration;
      await project.send(text, "follow-up");
      while ((await project.turnView()).state !== "idle") await sleep(50);
      const after = await project.view();
      if (project.liveGeneration !== generationBefore) process.stderr.write("carto: the context was collapsed.\n");
      if (after.error !== null) process.stderr.write(`carto: error: ${after.error}\n`);
      for (const record of after.brain.chat) {
        if (record.author !== "agent" || seen.has(record.id)) continue;
        seen.add(record.id);
        process.stdout.write(`${record.text}\n`);
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`carto: ${message}\n`);
  process.exitCode = 1;
});
