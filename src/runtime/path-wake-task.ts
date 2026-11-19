import type { Context } from "@earendil-works/chord/context";
import { defineTask } from "@earendil-works/pi-durable";
import type { TaskRuntime } from "@earendil-works/pi-durable";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { BrainStore } from "./brain-store.js";
import { resolveProjectWatchPath } from "./workspace.js";

export const PATH_WAKE_TASK_NAME = "carto.path-wake";
export const PATH_WAKE_POLL_MS = 1_000;
export const MAX_PATH_WAKE_ENTRIES = 10_000;

export class PathWakeError extends Error {}

type PathWakeInput = { wakeId: string; condition: string; baseline: string };
type PathWakeState = { phase: "watch" };
type PathWakeRuntime = TaskRuntime<PathWakeInput, PathWakeState, { wakeId: string }, object>;

/** A Pi Durable sleep loop. It observes a bounded project path without a second timer system. */
export function createPathWakeTask(projectRoot: string, brain: BrainStore) {
  return defineTask<PathWakeInput, PathWakeState, { wakeId: string }>({
    name: PATH_WAKE_TASK_NAME,
    version: 1,
    initial: (input) => {
      if (input.wakeId === "" || input.condition === "") throw new RangeError("A path wake needs an id and path.");
      return { phase: "watch" };
    },
    phases: {
      watch: async (task, runtime, context) => {
        let current: string;
        try {
          current = await pathFingerprint(projectRoot, task.input.condition);
        } catch (error) {
          if (!(error instanceof PathWakeError)) throw error;
          await deliverPathWake(task.input.wakeId, task.input.condition, brain, runtime, context);
          return;
        }
        if (current !== task.input.baseline) {
          await deliverPathWake(task.input.wakeId, task.input.condition, brain, runtime, context);
          return;
        }
        await runtime.sleepUntil(runtime.now() + PATH_WAKE_POLL_MS, { phase: "watch" }, context);
      },
    },
    abort: async (task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", result: { wakeId: task.input.wakeId } } }),
        context,
      );
    },
  });
}

export async function pathFingerprint(projectRoot: string, condition: string): Promise<string> {
  try {
    const target = await resolveProjectWatchPath(projectRoot, condition);
    const info = await stat(target.path);
    return JSON.stringify({
      path: target.relativePath,
      entry: await fingerprintEntry(target.path, info, target.path === target.root ? new Set([".brain"]) : undefined),
    });
  } catch (error) {
    if (error instanceof PathWakeError) throw error;
    return "unavailable";
  }
}

async function fingerprintEntry(
  path: string,
  info: Awaited<ReturnType<typeof stat>>,
  ignoredDirectEntries?: ReadonlySet<string>,
): Promise<unknown> {
  const current = fileSignature(info);
  if (!info.isDirectory()) return current;

  const entries = (await readdir(path, { withFileTypes: true }))
    .filter((entry) => !ignoredDirectEntries?.has(entry.name))
    .sort((first, second) => first.name.localeCompare(second.name));
  if (entries.length > MAX_PATH_WAKE_ENTRIES) {
    throw new PathWakeError(`Carto watches folders with up to ${MAX_PATH_WAKE_ENTRIES} direct entries.`);
  }
  return {
    ...current,
    entries: await Promise.all(
      entries.map(async (entry) => {
        try {
          return { name: entry.name, entry: await fingerprintDirectChild(join(path, entry.name)) };
        } catch (error) {
          if (isMissingFile(error)) return { name: entry.name, entry: "missing" };
          throw error;
        }
      }),
    ),
  };
}

async function fingerprintDirectChild(path: string): Promise<unknown> {
  const info = await lstat(path);
  return { kind: fileKind(info), ...fileSignature(info) };
}

function fileSignature(info: Awaited<ReturnType<typeof stat>>): Record<string, number | boolean> {
  return {
    directory: info.isDirectory(),
    file: info.isFile(),
    size: Number(info.size),
    modifiedAt: Number(info.mtimeMs),
    changedAt: Number(info.ctimeMs),
    inode: Number(info.ino),
  };
}

function fileKind(info: Awaited<ReturnType<typeof lstat>>): string {
  if (info.isSymbolicLink()) return "symbolic-link";
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function deliverPathWake(
  wakeId: string,
  condition: string,
  brain: BrainStore,
  runtime: PathWakeRuntime,
  context: Context,
): Promise<void> {
  const current = (await brain.read()).wakes.find((wake) => wake.id === wakeId);
  if (current?.kind === "path" && current.status === "armed" && current.condition === condition) {
    await brain.apply({ kind: "wake.upsert", wake: { ...current, status: "ready" } });
    await brain.apply({ kind: "activity.set", activity: { kind: "woken", detail: wakeId } });
  }
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "completed", result: { wakeId } } }),
    context,
  );
}
