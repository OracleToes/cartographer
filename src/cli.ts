import { parseArgs } from "node:util";

/**
 * Placeholder entry point. Carto is being rebuilt from `MINI.md`; the agent
 * core, the projection, the tools, and the screen do not exist yet. This
 * command reports that honestly and does nothing else. The designed
 * interface is `MINI.md` §8 and is the person's to mark.
 */

const STATUS = [
  "carto is being rebuilt from its specification (MINI.md).",
  "The agent core and the interface do not exist yet; only --help works.",
].join("\n");

function usage(): string {
  return [
    "Usage: carto [--help]",
    "",
    "Carto reads its global configuration from ~/.carto/config.json. The first",
    "--model value will create that file once the config loader exists.",
    "",
    STATUS,
  ].join("\n");
}

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: { help: { type: "boolean", short: "h" } },
  allowPositionals: false,
});

if (parsed.values.help) {
  process.stdout.write(`${usage()}\n`);
  process.exitCode = 0;
} else {
  process.stderr.write(`${STATUS}\n`);
  process.exitCode = 1;
}
