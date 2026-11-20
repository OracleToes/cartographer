/**
 * The collapse and the archive (MINI.md §4, §5, §6; docs/intent.md §17, §19,
 * §28, §29, §34; docs/open-questions.md §3).
 *
 * One Pi store per generation. A collapse creates a fresh store for the new
 * generation; the previous generation's store is sealed read-only and becomes
 * the archive. The Brain is separate from Pi storage and is never touched by
 * the seal; a crash cannot lose Brain state. At most one sealed generation
 * exists at a time: when the next collapse seals the live store, the older
 * archive has had its one collapse of grace, and is purged — after any
 * pinned-to-archive records are exported into the Brain.
 *
 * The frozen projection snapshot for a generation is written once, at
 * creation, and is immutable until purge.
 *
 * Recovery at open is derived from those rules: a generation whose snapshot
 * is missing never existed as a frozen whole (crash mid-creation), so it is
 * deleted and the Brain — which is authoritative — builds the next one.
 * Anything beyond the newest live store and its archive is purged the same
 * way, crash remainders included.
 */
import { chmodSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { freshnessMarks } from "../domain/freshness.js";
import { projectContext } from "../domain/projection.js";
import type { CartoBrain } from "../domain/records.js";
import type { BrainStore } from "./brain-store.js";
import { sha256File, resolveInsideRoot } from "./digest.js";
import { contextDirectory, removeSnapshot, sealSnapshot, snapshotPaths, unsealSnapshot, writeSnapshot } from "./projection-files.js";

export interface GenerationFiles {
  generation: string;
  store: string;
  markdown: string;
  sidecar: string;
  hasStore: boolean;
  hasMarkdown: boolean;
  hasSidecar: boolean;
  mtimeMs: number;
}

export function generationPaths(root: string, generation: string): { store: string; markdown: string; sidecar: string } {
  const directory = contextDirectory(root);
  const paths = snapshotPaths(root, generation);
  return { store: resolve(directory, `${generation}.sqlite`), markdown: paths.markdown, sidecar: paths.sidecar };
}

export function newGenerationId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "T");
  return `gen-${stamp}Z-${randomBytes(3).toString("hex")}`;
}

function candidateGenerationIds(root: string): Set<string> {
  const directory = contextDirectory(root);
  const ids = new Set<string>();
  for (const name of readdirSync(directory)) {
    const match = /^(gen-[\w-]+)\.(sqlite|projection\.md|projection\.json)$/.exec(name);
    if (match !== null && match[1] !== undefined) ids.add(match[1]);
  }
  return ids;
}

export function discoverGenerations(root: string): GenerationFiles[] {
  const directory = contextDirectory(root);
  const generations: GenerationFiles[] = [];
  for (const generation of candidateGenerationIds(root)) {
    const paths = generationPaths(root, generation);
    const storeStat = existsSync(paths.store) ? statSync(paths.store) : undefined;
    const markdownStat = existsSync(paths.markdown) ? statSync(paths.markdown) : undefined;
    const sidecarStat = existsSync(paths.sidecar) ? statSync(paths.sidecar) : undefined;
    const mtimeMs = Math.max(storeStat?.mtimeMs ?? 0, markdownStat?.mtimeMs ?? 0, sidecarStat?.mtimeMs ?? 0);
    generations.push({
      generation,
      store: paths.store,
      markdown: paths.markdown,
      sidecar: paths.sidecar,
      hasStore: storeStat !== undefined,
      hasMarkdown: markdownStat !== undefined,
      hasSidecar: sidecarStat !== undefined,
      mtimeMs,
    });
  }
  // Newest first. Ties fall back to the generation name, which starts with a timestamp.
  return generations.sort((left, right) => (right.mtimeMs - left.mtimeMs) || right.generation.localeCompare(left.generation));
}

function statMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}

function chmodBestEffort(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // best-effort; a sealed file is a courtesy enforced by the OS, not a gate
  }
}

export function removeGenerationFiles(root: string, generation: GenerationFiles): void {
  // The exports seam runs before anything is unlinked. Nothing can be pinned
  // to the archive yet — the marker shape waits for the recovery tooling —
  // so the default exports nothing and the order is already correct for
  // when it lands.
  unlinkIfExists(generation.store);
  removeSnapshot({ directory: contextDirectory(root), markdown: generation.markdown, sidecar: generation.sidecar });
}

function unlinkIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Bring the generations in line with the rules at open. Returns the live
 * generation, or null when none is valid and one must be created.
 */
export function reconcileGenerations(root: string): { live: GenerationFiles | null; archive: GenerationFiles | null; removed: string[] } {
  const removed: string[] = [];
  // A generation missing any piece of its snapshot never existed as a frozen
  // whole: delete it and let the Brain build the next one.
  for (;;) {
    const generations = discoverGenerations(root);
    const head = generations[0];
    if (head === undefined) return { live: null, archive: null, removed };
    if (head.hasStore && head.hasMarkdown && head.hasSidecar) break;
    removeGenerationFiles(root, head);
    removed.push(head.generation);
  }
  const generations = discoverGenerations(root);
  const live = generations[0] ?? null;
  const archive = generations[1] ?? null;
  // One sealed generation at a time. Anything older is crash remainders.
  for (const extra of generations.slice(2)) {
    removeGenerationFiles(root, extra);
    removed.push(extra.generation);
  }
  // The live store may have been sealed by a crash mid-collapse; make it writable again.
  if (live !== null) {
    chmodBestEffort(live.store, 0o644);
    try {
      const paths = snapshotPaths(root, live.generation);
      unsealSnapshot(paths);
    } catch {
      // best-effort
    }
  }
  if (archive !== null) {
    chmodBestEffort(archive.store, 0o444);
    sealSnapshot(snapshotPaths(root, archive.generation));
  }
  return { live, archive, removed };
}

/**
 * Verify every file-backed evidence reference against the filesystem and
 * apply the resulting marks. Must run before the snapshot is rendered, so
 * the frozen projection carries the fresh-from-rebuild truth.
 */
export async function refreshFreshness(root: string, brain: CartoBrain, apply: BrainStore["apply"], now: number): Promise<CartoBrain> {
  const paths = new Set<string>();
  for (const node of brain.atlas) for (const ref of node.evidence) if (ref.kind === "file") paths.add(ref.path);
  for (const pin of [...brain.userPins, ...brain.carryPins]) if (pin.source.kind === "file") paths.add(pin.source.path);
  const digests = new Map<string, string | null>();
  for (const path of paths) {
    const real = resolveInsideRoot(root, path);
    digests.set(path, real === null ? null : await sha256File(real));
  }
  const digestFor = (path: string): string | null => digests.get(path) ?? null;
  const marks = freshnessMarks(brain, digestFor);
  if (marks.kind === "evidence.refresh" && marks.marks.length === 0) return brain;
  return apply(marks, now);
}

export interface CollapseOptions {
  /**
   * The purge's export step, injected for the day the pin-to-archive marker
   * shape is confirmed. Called with the archived generation's files before
   * anything is unlinked. Default: nothing is exportable yet.
   */
  exportPinnedArchiveRecords?: (archiveGeneration: string, brain: BrainStore) => void | Promise<void>;
}

export interface CollapseReport {
  /** The fresh generation, its snapshot written and immutable. */
  generation: string;
  /** The generation that just became the archive, sealed read-only. */
  sealed: string;
  /** The older generation purged after its one collapse of grace, if any. */
  purged: string | undefined;
}

/**
 * Collapse: rebuild the Brain's freshness marks, render the frozen
 * projection for the new generation, seal the old store as the archive,
 * export-then-delete the archive whose grace just expired, and VACUUM the
 * Brain. The caller owns the live session's lifecycle around this call.
 */
export async function collapse(root: string, brain: BrainStore, options: CollapseOptions = {}): Promise<CollapseReport> {
  const now = Date.now();
  const refreshed = await refreshFreshness(root, brain.read(), brain.apply.bind(brain), now);
  const projection = projectContext(refreshed);

  const discovered = discoverGenerations(root);
  const live = discovered[0];
  if (live === undefined) throw new Error("No live generation exists to collapse.");
  const generation = newGenerationId(new Date(now));

  // 1. Snapshot first: no store exists for the new generation until the
  //    bytes are frozen on disk.
  writeSnapshot(root, generation, projection, now);
  // 2. The old store becomes the archive, sealed read-only with its snapshot.
  chmodBestEffort(live.store, 0o444);
  try {
    sealSnapshot(snapshotPaths(root, live.generation));
  } catch {
    // best-effort
  }
  const exports = options.exportPinnedArchiveRecords ?? (() => undefined);
  // 3. The previous archive had its one collapse of grace. Export, then delete.
  let purged: string | undefined;
  const priorArchive = discovered[1];
  if (priorArchive !== undefined) {
    await exports(priorArchive.generation, brain);
    removeGenerationFiles(root, priorArchive);
    purged = priorArchive.generation;
  }
  // 4. Crash remainders beyond live and archive take the same exports-first path.
  for (const extra of discovered.slice(2)) {
    await exports(extra.generation, brain);
    removeGenerationFiles(root, extra);
  }
  brain.compact();
  return { generation, sealed: live.generation, purged };
}
