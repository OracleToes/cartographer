#!/usr/bin/env node
/**
 * Draw the workspace, without a session (docs: `src/ui/preview.ts`).
 *
 *   npm run ui                 the transcript, the archive, help and the palette
 *   npm run ui -- transcript 120   one frame at a width
 *
 * The frames come from the same components the app mounts, so what this prints
 * is what the app draws. It exists because a terminal UI has no screenshot.
 */
import { previews } from "../dist/ui/preview.js";

const [requested, widthArg] = process.argv.slice(2);
const width = Number(widthArg ?? 110);
const all = previews(Number.isFinite(width) ? width : 110);

if (requested !== undefined) {
  const frame = all[requested];
  if (frame === undefined) {
    console.error(`no such frame: ${requested} (try ${Object.keys(all).join(", ")})`);
    process.exit(1);
  }
  process.stdout.write(`${frame}\n`);
} else {
  for (const [name, frame] of Object.entries(all)) {
    process.stdout.write(`\n── ${name} ─────────────────────────────────────\n`);
    process.stdout.write(`${frame}\n`);
  }
}
