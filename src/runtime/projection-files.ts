/**
 * The frozen projection's per-generation snapshot files (§5.6):
 * `<generation>.projection.md` plus `<generation>.projection.json` under
 * `.brain/context/`. Written once, atomically; immutable for the life of
 * the generation; deleted whole when the generation ends. A crash
 * reopens the identical bytes.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { Projection } from "../domain/projection.js";

/** Fingerprint exact frozen projection bytes; this detects changes, not provenance. */
export function projectionBytesDigest(markdown: Buffer, sidecar: Buffer): string {
  return createHash("sha256").update("carto-return-head-v1\0").update(String(markdown.length)).update("\0").update(markdown)
    .update(String(sidecar.length)).update("\0").update(sidecar).digest("hex");
}

export interface SnapshotPaths {
  directory: string;
  markdown: string;
  sidecar: string;
}

export function contextDirectory(root: string): string {
  const directory = resolve(root, ".brain/context");
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function snapshotPaths(root: string, generation: string): SnapshotPaths {
  const directory = contextDirectory(root);
  return {
    directory,
    markdown: resolve(directory, `${generation}.projection.md`),
    sidecar: resolve(directory, `${generation}.projection.json`),
  };
}

/** Atomic: temp file, then rename. Either both files exist or neither does, for a reader that checks both. */
export function writeSnapshot(root: string, generation: string, projection: Projection, createdAt: number): SnapshotPaths {
  const paths = snapshotPaths(root, generation);
  const tempMarkdown = `${paths.markdown}.tmp-${process.pid}`;
  const tempSidecar = `${paths.sidecar}.tmp-${process.pid}`;
  const sidecar = {
    generation,
    createdAt,
    parts: projection.parts.map((part) => ({ id: part.id, label: part.label, tokens: part.tokens })),
    total: projection.total,
    // Which Chat records the head holds: a rebuild in the middle of a
    // generation keeps to these, so a message said since is not read twice.
    chat: projection.chatIds,
    ephemeralItems: projection.ephemeralItems ?? [],
  };
  writeFileSync(tempMarkdown, projection.text, { mode: 0o644 });
  writeFileSync(tempSidecar, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o644 });
  renameSync(tempMarkdown, paths.markdown);
  renameSync(tempSidecar, paths.sidecar);
  return paths;
}

/** Best-effort read-only seal; a sealed file cannot be edited in place. */
export function sealSnapshot(paths: SnapshotPaths): void {
  chmodSync(paths.markdown, 0o444);
  chmodSync(paths.sidecar, 0o444);
}

/** Restore owner write on live files (the crash-mid-seal repair path). */
export function unsealSnapshot(paths: SnapshotPaths): void {
  try {
    chmodSync(paths.markdown, 0o644);
    chmodSync(paths.sidecar, 0o644);
  } catch {
    // best-effort
  }
}

export function removeSnapshot(paths: SnapshotPaths): void {
  rmSync(paths.markdown, { force: true });
  rmSync(paths.sidecar, { force: true });
}
