import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import type { CarryPin, SourceRef } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { createPatchApplyTask, PATCH_APPLY_TASK_NAME } from "./change-task.js";
import type { GlobalConfig, ModelRef } from "./config.js";
import { modelsForConfig } from "./llama-swap-model.js";
import { LiveCarryDocument, readLiveCarry } from "./live-carry.js";
import { createMiniExtension } from "./mini-extension.js";
import { createPathWakeTask, PATH_WAKE_TASK_NAME, pathFingerprint } from "./path-wake-task.js";
import { createTimeWakeTask, TIME_WAKE_TASK_NAME } from "./wake-task.js";
import { digestProjectFile, resolveProjectWatchPath } from "./workspace.js";

export const CONTEXT_BUDGET = 16_000;

const MINI_INSTRUCTIONS = [
  "Use the chat tool for every message to the person.",
  "Do not treat plain model text as a person-facing message.",
  "Inspect before you make a claim about a project file.",
  "Use Ledger and Atlas for durable records.",
  "Propose a change before an approved patch applies it.",
  "Use request_collapse when the live context must rotate.",
].join("\n");

export interface LiveSessionOptions {
  path: string;
  model: ModelRef;
  /** Global configuration is needed only when a llama-swap model is selected. */
  config?: GlobalConfig;
  projectRoot: string;
  brain: BrainStore;
  /** Test or host-provided Pi model catalog. Normal starts use the built-in catalog. */
  models?: Models;
  contextBudget?: number;
  initialCarryPins?: CarryPin[];
}

export class LiveSession {
  private constructor(
    private readonly projectRoot: string,
    private readonly harness: Harness,
    private readonly root: Awaited<ReturnType<Harness["root"]>>,
    private readonly database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
    private readonly timeWakeTask: ReturnType<typeof createTimeWakeTask>,
    private readonly pathWakeTask: ReturnType<typeof createPathWakeTask>,
    private readonly patchApplyTask: ReturnType<typeof createPatchApplyTask>,
  ) {}

  static async open(options: LiveSessionOptions): Promise<LiveSession> {
    await mkdir(dirname(options.path), { recursive: true });
    const database = await openNodeSqliteDatabase(options.path);
    let harness: Harness | undefined;
    try {
      await database.exec("PRAGMA secure_delete = ON");
      const storage = await SqliteStorage.open(database, { prefix: "live_" });
      const models =
        options.models ??
        (options.config === undefined ? builtinModels() : modelsForConfig(options.config, options.model) ?? builtinModels());
      if (models.getModel(options.model.provider, options.model.modelId) === undefined) {
        throw new Error(`Pi does not know the model ${options.model.provider}/${options.model.modelId}.`);
      }

      const registry = createRegistry();
      const timeWakeTask = createTimeWakeTask(options.brain);
      const pathWakeTask = createPathWakeTask(options.projectRoot, options.brain);
      const patchApplyTask = createPatchApplyTask(options.projectRoot, options.brain);
      registry.install(
        createMiniExtension({
          brain: options.brain,
          projectRoot: options.projectRoot,
          contextId: basename(options.path, ".sqlite"),
          contextBudget: options.contextBudget ?? CONTEXT_BUDGET,
          durableTasks: [timeWakeTask, pathWakeTask, patchApplyTask],
        }),
      );

      harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
      const agent = {
        model: options.model,
        instructions: MINI_INSTRUCTIONS,
        compaction: { enabled: false },
        maxTurns: 16,
      };
      const root = await harness.root(BACKGROUND_CONTEXT, { agent });
      await root.configure(agent, BACKGROUND_CONTEXT);
      await root.commit(async (transaction) => {
        const document = await transaction.doc(LiveCarryDocument, root.id);
        if (options.initialCarryPins !== undefined) {
          document.pins = JSON.parse(JSON.stringify(options.initialCarryPins));
        }
      }, BACKGROUND_CONTEXT);
      harness.resume();
      return new LiveSession(options.projectRoot, harness, root, database, timeWakeTask, pathWakeTask, patchApplyTask);
    } catch (error) {
      if (harness === undefined) await database.close();
      else await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  async submit(text: string, requestId: string) {
    const submission = await this.root.submit({ type: "input", content: text, requestId }, BACKGROUND_CONTEXT);
    return submission.wait(BACKGROUND_CONTEXT);
  }

  async liveCarryPins(): Promise<CarryPin[]> {
    return readLiveCarry(await this.harness.snapshot(LiveCarryDocument, this.root.id, BACKGROUND_CONTEXT));
  }

  async refreshCarryPins(): Promise<void> {
    const current = await this.liveCarryPins();
    const refreshed = await Promise.all(current.map((pin) => refreshCarryPin(this.projectRoot, pin)));
    if (sameJson(current, refreshed)) return;
    await this.root.commit(async (transaction) => {
      const document = await transaction.doc(LiveCarryDocument, this.root.id);
      document.pins = JSON.parse(JSON.stringify(refreshed));
    }, BACKGROUND_CONTEXT);
  }

  async ensureTimeWake(wakeId: string, until: number): Promise<void> {
    const matching = (await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === TIME_WAKE_TASK_NAME && isTimeWakeInput(record.input, wakeId),
    );
    if (matching.some(({ record }) => isTimeWakeInput(record.input, wakeId) && record.input.until === until)) return;
    await Promise.all(matching.map(({ record }) => this.harness.abortTask(record.id, BACKGROUND_CONTEXT)));
    await this.root.commit(async (transaction) => {
      await transaction.createTask(this.timeWakeTask, { wakeId, until }, {
        ownership: { kind: "conversation" },
        background: true,
      });
    }, BACKGROUND_CONTEXT);
    this.harness.resume();
  }

  async cancelTimeWake(wakeId: string): Promise<void> {
    const matching = (await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === TIME_WAKE_TASK_NAME && isTimeWakeInput(record.input, wakeId),
    );
    await Promise.all(matching.map(({ record }) => this.harness.abortTask(record.id, BACKGROUND_CONTEXT)));
  }

  async ensurePathWake(wakeId: string, condition: string): Promise<void> {
    const matching = (await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === PATH_WAKE_TASK_NAME && isPathWakeInput(record.input, wakeId),
    );
    if (matching.some(({ record }) => isPathWakeInput(record.input, wakeId) && record.input.condition === condition)) return;
    await Promise.all(matching.map(({ record }) => this.harness.abortTask(record.id, BACKGROUND_CONTEXT)));
    await resolveProjectWatchPath(this.projectRoot, condition);
    const baseline = await pathFingerprint(this.projectRoot, condition);
    await this.root.commit(async (transaction) => {
      await transaction.createTask(this.pathWakeTask, { wakeId, condition, baseline }, {
        ownership: { kind: "conversation" },
        background: true,
      });
    }, BACKGROUND_CONTEXT);
    this.harness.resume();
  }

  async cancelPathWake(wakeId: string): Promise<void> {
    const matching = (await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === PATH_WAKE_TASK_NAME && isPathWakeInput(record.input, wakeId),
    );
    await Promise.all(matching.map(({ record }) => this.harness.abortTask(record.id, BACKGROUND_CONTEXT)));
  }

  async ensurePatchApply(changeId: string): Promise<void> {
    const matching = (await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.filter(
      ({ record }) => record.kind === PATCH_APPLY_TASK_NAME && isPatchApplyInput(record.input, changeId),
    );
    const existing = matching[0]?.record.id;
    const taskId =
      existing ??
      (await this.root.commit(async (transaction) => {
        return transaction.createTask(this.patchApplyTask, { changeId }, {
          ownership: { kind: "conversation" },
          background: true,
        });
      }, BACKGROUND_CONTEXT));
    this.harness.resume();
    await this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
  }

  async vacuum(): Promise<void> {
    await this.database.exec("PRAGMA secure_delete = ON");
    await this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await this.database.exec("VACUUM");
    await this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
}

async function refreshCarryPin(root: string, pin: CarryPin): Promise<CarryPin> {
  return { ...pin, source: await refreshCarrySource(root, pin.source) };
}

async function refreshCarrySource(root: string, source: SourceRef): Promise<SourceRef> {
  if (source.kind !== "file") return source;
  try {
    const current = await digestProjectFile(root, source.path);
    return { ...source, freshness: current.digest === source.digest ? "fresh" : "stale" };
  } catch {
    return { ...source, freshness: "stale" };
  }
}

function sameJson(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function isPathWakeInput(value: unknown, wakeId: string): value is { wakeId: string; condition: string; baseline: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    "wakeId" in value &&
    "condition" in value &&
    "baseline" in value &&
    value.wakeId === wakeId &&
    typeof value.condition === "string" &&
    typeof value.baseline === "string"
  );
}

function isPatchApplyInput(value: unknown, changeId: string): value is { changeId: string } {
  return value !== null && typeof value === "object" && "changeId" in value && value.changeId === changeId;
}

function isTimeWakeInput(value: unknown, wakeId: string): value is { wakeId: string; until: number } {
  return (
    value !== null &&
    typeof value === "object" &&
    "wakeId" in value &&
    "until" in value &&
    value.wakeId === wakeId &&
    typeof value.until === "number"
  );
}
