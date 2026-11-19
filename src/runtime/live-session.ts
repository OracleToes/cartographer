import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Cursor } from "@earendil-works/pi-durable";

import {
  AssistantEntry,
  InboxDoc,
  LiveDoc,
  ToolResultEntry,
  type InboxState,
  type LiveState,
  createRegistry,
  Harness,
} from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import type { CarryPin, SourceRef } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { createPatchApplyTask, PATCH_APPLY_TASK_NAME } from "./change-task.js";
import type { GlobalConfig, ModelRef } from "./config.js";
import { modelsForConfig } from "./llama-swap-model.js";
import { LiveCarryDocument, readLiveCarry } from "./live-carry.js";
import { createCartoExtension } from "./carto-extension.js";
import { createPathWakeTask, PATH_WAKE_TASK_NAME, pathFingerprint } from "./path-wake-task.js";
import { createPrefillMonitor, type PrefillMonitor, type PrefillState } from "./prefill.js";
import { createTimeWakeTask, TIME_WAKE_TASK_NAME } from "./wake-task.js";
import { digestProjectFile, resolveProjectWatchPath } from "./workspace.js";

export const CONTEXT_BUDGET = 16_000;

const CARTO_INSTRUCTIONS = [
  "Use the chat tool for deliberate person-facing Chat only.",
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
  /** A monitor for the server's prompt reading; created for llama-swap when absent. */
  prefill?: PrefillMonitor;
}

export type LiveActivityKind = "reasoning" | "model" | "tool-call" | "tool-output" | "warning" | "error";

export interface LiveActivity {
  /** A presentation-only ID. It is not a durable record ID. */
  id: string;
  kind: LiveActivityKind;
  label: string;
  text: string;
  streaming: boolean;
  completed: boolean;
}

export interface LiveSessionView {
  busy: boolean;
  queued: Array<{ id: string; mode: "steer" | "follow-up"; text: string }>;
  activity: LiveActivity[];
}

export class LiveSession {
  private constructor(
    private readonly projectRoot: string,
    private readonly harness: Harness,
    /** How far llama.cpp is with reading a prompt, when the provider reports it. */
    readonly prefill: PrefillMonitor,
    /** The model's context window, read from the Pi catalog at open. */
    readonly contextWindow: number,
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
      const providerId = options.model.provider;
      if (models.getModel(options.model.provider, options.model.modelId) === undefined) {
        throw new Error(`Pi does not know the model ${options.model.provider}/${options.model.modelId}.`);
      }

      const registry = createRegistry();
      const timeWakeTask = createTimeWakeTask(options.brain);
      const pathWakeTask = createPathWakeTask(options.projectRoot, options.brain);
      const patchApplyTask = createPatchApplyTask(options.projectRoot, options.brain);
      registry.install(
        createCartoExtension({
          brain: options.brain,
          projectRoot: options.projectRoot,
          contextId: basename(options.path, ".sqlite"),
          contextBudget: options.contextBudget ?? CONTEXT_BUDGET,
          durableTasks: [timeWakeTask, pathWakeTask, patchApplyTask],
        }),
      );

      // Wrap the Models object the Harness is given, so the request that Pi
      // Durable builds itself still carries `return_progress`. Only the
      // selected provider is touched; every other request passes through.
      const prefill =
        options.prefill ??
        createPrefillMonitor({ provider: providerId, ...(options.config?.llamaSwapEndpoint === undefined ? {} : {}) });
      harness = await Harness.open(storage, { models: prefill.wrap(models), registry }, BACKGROUND_CONTEXT);
      const contextWindow = models.getModel(providerId, options.model.modelId)?.contextWindow ?? 32_768;
      const agent = {
        model: options.model,
        instructions: CARTO_INSTRUCTIONS,
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
      return new LiveSession(
        options.projectRoot,
        harness,
        prefill,
        contextWindow,
        root,
        database,
        timeWakeTask,
        pathWakeTask,
        patchApplyTask,
      );
    } catch (error) {
      if (harness === undefined) await database.close();
      else await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  async submit(text: string, requestId: string, whenBusy: "steer" | "followUp" = "followUp"): Promise<void> {
    const submission = await this.root.submit({ type: "input", content: text, requestId, whenBusy }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
  }

  async continue(): Promise<void> {
    const submission = await this.root.submit({ type: "continue" }, BACKGROUND_CONTEXT);
    await submission.wait(BACKGROUND_CONTEXT);
  }

  /**
   * Pi `continue` can resume an unfinished run only. When Carto is truly idle,
   * create a control entry that starts useful agent work without a Person Chat
   * record. Its content is deliberately not a person message in Carto.
   */
  async continueOrStart(requestId: string): Promise<void> {
    const live = await this.harness.snapshot(LiveDoc, this.root.id, BACKGROUND_CONTEXT);
    if (live?.runFailure !== undefined) {
      await this.continue();
      return;
    }
    const submission = await this.root.submit(
      {
        type: "input",
        content: "Start or continue the next useful Carto task from the current context. Do not create Person Chat unless the person sends a message.",
        requestId,
        entry: { kind: "carto.start-work", data: { source: "turn-control" } },
      },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
  }

  /**
   * Pi cannot resume an arbitrary provider socket after an edit. Start a new
   * model request at a durable boundary and mark it as Carto continuation data,
   * not a deliberate Person Chat record.
   */
  async resumeFromDraft(draft: string, requestId: string): Promise<void> {
    const content = [
      "Continue the interrupted response. The person edited the partial draft below.",
      "Keep useful text, correct it when needed, and continue after it. Do not call this a person message.",
      "",
      "Edited partial draft:",
      draft,
    ].join("\n");
    const submission = await this.root.submit(
      { type: "input", content, requestId, entry: { kind: "carto.resume", data: { edited: true } } },
      BACKGROUND_CONTEXT,
    );
    await submission.wait(BACKGROUND_CONTEXT);
  }

  async cancel(): Promise<void> {
    await this.root.abort(BACKGROUND_CONTEXT);
  }

  async pause(): Promise<string> {
    const live = await this.harness.snapshot(LiveDoc, this.root.id, BACKGROUND_CONTEXT);
    const message = live?.generation?.message;
    const draft = message === undefined ? "" : assistantDraft(message);
    // Abort the live generation task, not the whole conversation. This keeps
    // queued Steer and Follow-up inputs intact while the person edits a draft.
    if (live?.run !== undefined) {
      await this.harness.abortTask(live.run.taskId, BACKGROUND_CONTEXT);
      await this.harness.waitForTask(live.run.taskId, BACKGROUND_CONTEXT);
    }
    return draft;
  }

  /** How far the newest prompt reading is, or undefined before the first request. */
  prefillState(): PrefillState | undefined {
    return this.prefill.current();
  }

  /** The last finished reading, for the status line after a run ends. */
  lastPrefill(): { fresh: number; ms: number; at: number } | undefined {
    return this.prefill.last();
  }

  /**
   * Mark a callback dirty on every stored commit, for a screen that must not
   * render inside a watch. The callback runs one microtask after a commit is
   * stored, so it can read, but it must not write or wait.
   */
  onCommit(listener: () => void): () => void {
    const observation = this.harness.observeCommits({
      advance: () => listener(),
      end: () => undefined,
    });
    return () => observation.detach();
  }

  /**
   * The live documents only, for a frame that must be cheap. It never reads
   * the transcript, so it is safe at ten frames a second on a long run.
   */
  async liveView(): Promise<LiveSessionView> {
    const [live, inbox] = await Promise.all([
      this.harness.snapshot(LiveDoc, this.root.id, BACKGROUND_CONTEXT),
      this.harness.snapshot(InboxDoc, this.root.id, BACKGROUND_CONTEXT),
    ]);
    return this.project(undefined, live, inbox);
  }

  async isBusy(): Promise<boolean> {
    return (await this.view()).busy;
  }

  async queuedInputs(): Promise<Array<{ id: string; mode: "steer" | "follow-up"; text: string }>> {
    return (await this.view()).queued;
  }

  /**
   * Pi Durable publishes live partials and tool slots. Carto projects those
   * public streams without writing a second stream parser or a second log.
   */
  async view(): Promise<LiveSessionView> {
    const [live, inbox, history] = await Promise.all([
      this.harness.snapshot(LiveDoc, this.root.id, BACKGROUND_CONTEXT),
      this.harness.snapshot(InboxDoc, this.root.id, BACKGROUND_CONTEXT),
      this.activeEntries(),
    ]);
    return this.project(history, live, inbox);
  }

  private project(
    history: readonly { model?: readonly unknown[] }[] | undefined,
    live: LiveState | null | undefined,
    inbox: InboxState | null | undefined,
  ): LiveSessionView {
    const queued: Array<{ id: string; mode: "steer" | "follow-up"; text: string }> = (inbox?.items ?? [])
      .filter((item): item is Extract<(typeof inbox extends undefined ? never : NonNullable<typeof inbox>["items"][number]), { mode: "steer" | "followUp" }> =>
        item.mode === "steer" || item.mode === "followUp",
      )
      .map((item, index): { id: string; mode: "steer" | "follow-up"; text: string } => ({
        id: `Q${index + 1}`,
        mode: item.mode === "steer" ? "steer" : "follow-up",
        text: contentText(item.content),
      }));
    // Do not cap completed activity. It stays visible as one-line folded
    // disclosures, so Carto never hides agent-generated content by age. A
    // frame that did not read the transcript keeps what it already has.
    const activity = completedActivity(history ?? []);
    if (live?.generation?.message !== undefined) {
      activity.push(...assistantActivity(live.generation.message, true, "live"));
    }
    if (live?.generation?.retry !== undefined) {
      activity.push({ id: "live-retry", kind: "warning", label: "Model retry", text: live.generation.retry.error, streaming: true, completed: false });
    }
    if (live?.runFailure !== undefined) {
      activity.push({
        id: "run-failure",
        kind: "error",
        label: `Run stopped: ${live.runFailure.reason}`,
        text: live.runFailure.detail ?? "The run stopped without an answer.",
        streaming: false,
        completed: true,
      });
    }
    if (live?.compactionFailure !== undefined) {
      activity.push({ id: "compaction-failure", kind: "warning", label: "Collapse needed", text: live.compactionFailure.error, streaming: false, completed: true });
    }
    for (const [index, tool] of (live?.tools ?? []).entries()) {
      const label = `Tool ${index + 1}: ${tool.name}`;
      if (tool.output !== undefined && tool.output !== "") {
        activity.push({ id: `live-tool-output-${index}`, kind: "tool-output", label, text: tool.output, streaming: tool.status !== "done", completed: tool.status === "done" });
      }
      if (tool.diagnostics !== undefined) {
        for (const [diagnosticIndex, diagnostic] of tool.diagnostics.entries()) {
          activity.push({
            id: `live-tool-diagnostic-${index}-${diagnosticIndex}`,
            kind: diagnostic.severity === "error" ? "error" : diagnostic.severity === "warn" ? "warning" : "tool-output",
            label,
            text: diagnostic.message,
            streaming: tool.status !== "done",
            completed: tool.status === "done",
          });
        }
      }
    }
    return { busy: live?.run !== undefined, queued, activity };
  }

  private async activeEntries(): Promise<Array<{ model?: readonly unknown[] }>> {
    const entries: Array<{ model?: readonly unknown[] }> = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.root.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return entries;
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

function completedActivity(entries: readonly { model?: readonly unknown[] }[]): LiveActivity[] {
  const result: LiveActivity[] = [];
  // `activeEntries()` is ascending. Keep the complete disclosure history in
  // that order, then append live partials below it. ScrollView follows the
  // newest output while an older item remains available in folded form.
  for (const [entryIndex, entry] of entries.entries()) {
    const message = entry.model?.[0];
    if (message === undefined || message === null || typeof message !== "object" || !("role" in message)) continue;
    const role = (message as { role?: unknown }).role;
    if (role === "assistant") result.push(...assistantActivity(message, false, `complete-${entryIndex}`));
    if (role === "toolResult") {
      const tool = message as { toolName?: unknown; content?: unknown; isError?: unknown };
      result.push({
        id: `complete-tool-${entryIndex}`,
        kind: tool.isError === true ? "error" : "tool-output",
        label: `Tool output: ${typeof tool.toolName === "string" ? tool.toolName : "tool"}`,
        text: contentText(tool.content),
        streaming: false,
        completed: true,
      });
    }
  }
  return result;
}

function assistantActivity(message: unknown, streaming: boolean, prefix: string): LiveActivity[] {
  if (message === null || typeof message !== "object" || !("content" in message)) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const result: LiveActivity[] = [];
  for (const [index, item] of content.entries()) {
    if (item === null || typeof item !== "object" || !("type" in item)) continue;
    const value = item as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown; argumentsError?: unknown };
    if (value.type === "thinking") {
      result.push({ id: `${prefix}-reasoning-${index}`, kind: "reasoning", label: "Reasoning", text: typeof value.thinking === "string" ? value.thinking : "", streaming, completed: !streaming });
    } else if (value.type === "text") {
      result.push({ id: `${prefix}-model-${index}`, kind: "model", label: "Model output", text: typeof value.text === "string" ? value.text : "", streaming, completed: !streaming });
    } else if (value.type === "toolCall") {
      const argumentText = value.argumentsError === undefined ? safeJson(value.arguments) : String(value.argumentsError);
      result.push({
        id: `${prefix}-tool-call-${index}`,
        kind: "tool-call",
        label: `Tool call: ${typeof value.name === "string" ? value.name : "tool"}`,
        text: argumentText,
        streaming,
        completed: !streaming,
      });
    }
  }
  const diagnostics = (message as { diagnostics?: unknown }).diagnostics;
  if (Array.isArray(diagnostics)) {
    for (const [index, diagnostic] of diagnostics.entries()) {
      if (diagnostic === null || typeof diagnostic !== "object") continue;
      const value = diagnostic as { type?: unknown; error?: { message?: unknown } };
      const text = typeof value.error?.message === "string" ? value.error.message : typeof value.type === "string" ? value.type : "Model diagnostic";
      result.push({ id: `${prefix}-diagnostic-${index}`, kind: "warning", label: "Model diagnostic", text, streaming, completed: !streaming });
    }
  }
  return result;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (item !== null && typeof item === "object" && "text" in item && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "Arguments could not be displayed.";
  }
}

function assistantDraft(message: unknown): string {
  if (message === null || typeof message !== "object" || !("content" in message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text?: string; thinking?: string } => item !== null && typeof item === "object" && "type" in item)
    .map((item) => (item.type === "text" ? item.text ?? "" : item.type === "thinking" ? item.thinking ?? "" : ""))
    .join("");
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
