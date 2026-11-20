import { randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { projectContext } from "../domain/context.js";
import { ensureHandles, resolveHandle, resolveHandleOfKind } from "../domain/handles.js";
import type {
  AtlasNode,
  DeletionTarget,
  CartoBrain,
  SourceRef,
  WakeEntry,
} from "../domain/types.js";
import { PromptStore } from "./prompt-store.js";
import { BrainStore } from "./brain-store.js";
import type { GlobalConfig } from "./config.js";
import { parseModelRef } from "./config.js";
import { CONTEXT_BUDGET, LiveSession, type LiveActivity, type LiveSessionView } from "./live-session.js";
import { brainDatabasePath, contextDatabasePath, contextDirectory, isContextGenerationName } from "./paths.js";
import { parseTimeWakeCondition } from "./wake.js";
import { digestProjectFile, inspectProjectFile, resolveProjectWatchPath } from "./workspace.js";

export class ProjectError extends Error {}

export interface ProjectView {
  brain: CartoBrain;
  context: ReturnType<typeof projectContext>;
  turn: TurnView;
  activity: LiveActivity[];
  /** The transient error of the newest failed run, if any. Ephemeral. */
  error: string | null;
  /** Whether an archive exists beyond the live store. Transient; derived at open and collapse. */
  archivePresent: boolean;
}

export type SendMode = "interruption" | "steer" | "follow-up";

export interface TurnView {
  state: "idle" | "running" | "cancelling";
  queued: Array<{ id: string; mode: "steer" | "follow-up"; text: string }>;
}

export class CartoProject {
  private readonly runningSubmissions = new Map<string, Promise<void>>();
  private turnState: TurnView["state"] = "idle";
  /**
   * Set when the agent's collapse tool, or a declined compaction, asked for a
   * collapse during a run. Applied when the run ends; never stored, because a
   * restart cannot honour it anyway.
   */
  private collapseRequested = false;
  /** Whether an archive exists beyond the live store. In-memory only. */
  private archivePresent = false;
  /** The generation whose store the live session holds. In-memory only; changes at collapse. */
  liveGeneration: string;

  private constructor(
    readonly root: string,
    readonly config: GlobalConfig,
    private readonly brainStore: BrainStore,
    private live: LiveSession,
    /** The last prompt the harness assembled, shared with the harness itself. */
    readonly prompts: PromptStore,
    liveGeneration: string,
  ) {
    this.liveGeneration = liveGeneration;
  }

  /**
   * Carto keeps one Pi store per live generation. There is no durable pointer
   * to a generation anywhere: at open, the stores are discovered by scanning
   * the context directory. The newest store is the live one; the second
   * newest, if any, is the archive, which gets its one collapse of grace at
   * the next collapse and is not opened for writing until then. Everything
   * older is deleted, which is the only safe reading of a collapse that
   * crashed part-way.
   *
   * A live session can always be rebuilt from the Brain alone, so adopting a
   * discovered store is an optimisation, never a correctness requirement.
   */
  static async open(root: string, config: GlobalConfig): Promise<CartoProject> {
    await mkdir(contextDirectory(root), { recursive: true });
    const brainStore = await BrainStore.open(brainDatabasePath(root));
    let live: LiveSession | undefined;
    let prompts: PromptStore | undefined;
    try {
      await removeUnreferencedContextFiles(root);
      const generation = await adoptLiveGeneration(root);
      const archivePresent = (await discoverContextStores(root)).archive !== undefined;
      const model = parseModelRef(config.model);
      prompts = new PromptStore();
      // Late binding: the session exists before the project does; the callback
      // fires from inside a tool, always after both exist.
      let target: CartoProject | undefined;
      live = await LiveSession.open({
        path: contextDatabasePath(root, generation),
        model,
        config,
        projectRoot: root,
        brain: brainStore,
        contextBudget: CONTEXT_BUDGET,
        promptStore: prompts,
        onCollapseRequest: () => {
          if (target !== undefined) target.collapseRequested = true;
        },
      });
      const opened = new CartoProject(root, config, brainStore, live, prompts, generation);
      opened.archivePresent = archivePresent;
      target = opened;
      await opened.refreshEvidence();
      await opened.syncHandles();
      await opened.reconcileWakes();
      return opened;
    } catch (error) {
      const cleanupFailures = await closeOpenedProjectResources(live, brainStore);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Carto could not finish opening the project.");
      }
      throw error;
    }
  }

  /**
   * Everything the screen shows, from storage. A view never writes: a screen
   * reads many times a second, and a read that commits would fight the agent
   * for the same Brain document. Handles are assigned where the Brain changes
   * (`open()` calls `syncHandles()`, and every decision that changes a record
   * brings its handle with it), so a read always finds a complete table.
   */
  /**
   * The last prompt the harness assembled.
   *
   * It lives on the project rather than on the screen so the screen and the
   * harness share one object across a UI restart, and so a headless run can read
   * it too.
   */
  async view(): Promise<ProjectView> {
    const [brain, liveView] = await Promise.all([this.brainStore.read(), this.live.view()]);
    return {
      brain,
      context: projectContext(brain, { budget: CONTEXT_BUDGET }),
      turn: this.projectTurnView(liveView),
      activity: liveView.activity,
      error: liveView.error,
      archivePresent: this.archivePresent,
    };
  }

  /**
   * A cheap view for a frame that the spinner clock asked for: the live
   * documents, the Brain, and the projection, without the transcript. The
   * transcript only changes when a run writes an entry, which arrives as a
   * commit, and a commit asks for a full read of its own.
   */
  async liveFrameView(): Promise<ProjectView> {
    const [brain, liveView] = await Promise.all([this.brainStore.read(), this.live.liveView()]);
    return {
      brain,
      context: projectContext(brain, { budget: CONTEXT_BUDGET }),
      turn: this.projectTurnView(liveView),
      activity: liveView.activity,
      error: liveView.error,
      archivePresent: this.archivePresent,
    };
  }

  /** How far the server is with reading the newest prompt. */
  prefill(): { current: ReturnType<LiveSession["prefillState"]>; last: ReturnType<LiveSession["lastPrefill"]>; window: number } {
    return { current: this.live.prefillState(), last: this.live.lastPrefill(), window: this.live.contextWindow };
  }

  /** The provider's own report of a prompt reading, for a screen that marks itself dirty. */
  onPrefill(listener: () => void): () => void {
    return this.live.prefill.subscribe(listener);
  }

  /** Every stored commit, for a screen that must redraw without a key press. */
  watchLive(listener: () => void): () => void {
    return this.live.onCommit(listener);
  }

  /**
   * Keep the private handle table in step with the Brain. No handle is
   * renumbered here; a collapse rebuilds the whole table. The UI calls this on
   * a timer, so a needless commit would churn SQLite: do not write when the
   * stored table already covers every record.
   */
  async syncHandles(): Promise<void> {
    const brain = await this.brainStore.read();
    const next = ensureHandles(brain.handles, brain);
    if (sameJson(next, brain.handles)) return;
    await this.brainStore.apply({ kind: "handles.sync" });
  }

  async refreshEvidence(): Promise<void> {
    const brain = await this.brainStore.read();
    for (const node of brain.atlas) {
      const evidence = await Promise.all(node.evidence.map((source) => refreshSource(this.root, source)));
      if (!sameJson(evidence, node.evidence)) {
        await this.brainStore.apply({ kind: "atlas.upsert", node: { ...node, evidence } });
      }
    }
    for (const pin of brain.userPins) {
      const source = await refreshSource(this.root, pin.source);
      if (!sameJson(source, pin.source)) await this.brainStore.apply({ kind: "pin.user.add", pin: { ...pin, source } });
    }
    for (const pin of brain.carryPins) {
      const source = await refreshSource(this.root, pin.source);
      if (!sameJson(source, pin.source)) await this.brainStore.apply({ kind: "pin.carry.add", pin: { ...pin, source } });
    }
    await this.syncHandles();
  }

  async addUserContextPin(item: string, reason: string): Promise<void> {
    const source: SourceRef = { kind: "context", contextId: this.liveGeneration, excerpt: item, freshness: "fresh" };
    await this.brainStore.apply({
      kind: "pin.user.add",
      pin: { id: `user:${randomUUID()}`, item, reason, source, createdAt: Date.now() },
    });
  }

  async addUserFilePin(item: string, reason: string, path: string, startLine: number, endLine: number): Promise<void> {
    const inspected = await inspectProjectFile(this.root, { path, startLine, endLine });
    const source: SourceRef = {
      kind: "file",
      path: inspected.path,
      startLine: inspected.startLine,
      endLine: inspected.endLine,
      digest: inspected.digest,
      excerpt: inspected.excerpt,
      freshness: "fresh",
    };
    await this.brainStore.apply({
      kind: "pin.user.add",
      pin: { id: `user:${randomUUID()}`, item, reason, source, createdAt: Date.now() },
    });
  }

  /**
   * Turn a short public handle into a private durable ID for an action. The UI
   * shows handles only; the storage ID stays inside the project layer.
   */
  async resolveTarget(handle: string, allowed: readonly import("../domain/handles.js").HandleKind[]): Promise<{ kind: import("../domain/handles.js").HandleKind; id: string }> {
    const brain = await this.brainStore.read();
    return resolveHandleOfKind(brain.handles, handle, allowed);
  }

  /** Resolve a list of handles, or every record of a kind when none is given. */
  async resolveIds(handles: readonly string[], kind: import("../domain/handles.js").HandleKind | undefined): Promise<string[]> {
    if (handles.length === 0) return [];
    const brain = await this.brainStore.read();
    return handles.map((handle) => {
      const resolved = resolveHandle(brain.handles, handle);
      if (resolved === undefined) throw new ProjectError(`Carto does not know the handle ${handle}.`);
      if (kind !== undefined && resolved.kind !== kind) throw new ProjectError(`The handle ${handle} does not name a ${kind} record.`);
      return resolved.id;
    });
  }

  /** Remove one record the person selected by its short handle. Single step, no undo. */
  async deleteHandleNow(handle: string): Promise<void> {
    const target = await this.deletionTargetFor(handle);
    await this.deleteNow(target.target, target.id);
  }

  /** Remove a pin, selected by its short handle. Single step, no undo. */
  async removePinHandleNow(handle: string): Promise<void> {
    const resolved = await this.resolveTarget(handle, ["pin"]);
    await this.deleteNow(await this.pinTarget(resolved.id), resolved.id);
  }

  /** Resolve a short handle to a deletion target. */
  async deletionTargetFor(handle: string): Promise<DeletionTarget> {
    const brain = await this.brainStore.read();
    const resolved = resolveHandleOfKind(brain.handles, handle, ["chat", "ledger", "atlas", "pin"]);
    if (resolved.kind === "pin") return { target: await this.pinTarget(resolved.id), id: resolved.id };
    if (resolved.kind === "chat" || resolved.kind === "ledger" || resolved.kind === "atlas") {
      return { target: resolved.kind, id: resolved.id };
    }
    throw new ProjectError(`The handle ${handle} does not name a record Carto can remove.`);
  }

  /** A pin handle can name either a user pin or a carry pin. */
  async pinTarget(id: string): Promise<"user-pin" | "carry-pin"> {
    const brain = await this.brainStore.read();
    if (brain.userPins.some((pin) => pin.id === id)) return "user-pin";
    if (brain.carryPins.some((pin) => pin.id === id)) return "carry-pin";
    throw new ProjectError("No pin exists with that handle.");
  }

  /**
   * Delete one record. Deletion is a single step: the record is gone from the
   * Brain. The frozen projection keeps showing it until the next collapse,
   * which is what a frozen projection means.
   */
  async deleteNow(target: DeletionTarget["target"], id: string): Promise<void> {
    const brain = await this.brainStore.read();
    if (!hasDeletionTarget(brain, target, id)) {
      throw new ProjectError(`No ${target} exists with that handle.`);
    }
    await this.brainStore.apply({ kind: "record.delete", target: { target, id } });
  }

  async editChat(id: string, text: string): Promise<void> {
    const clean = text.trim();
    if (clean === "") throw new ProjectError("Chat cannot be empty.");
    const record = (await this.brainStore.read()).chat.find((candidate) => candidate.id === id);
    if (record === undefined) throw new ProjectError(`No Chat record exists with id ${id}.`);
    await this.brainStore.apply({ kind: "chat.record", record: { ...record, text: clean, updatedAt: Date.now() } });
  }

  async addAgentChat(text: string): Promise<void> {
    const clean = text.trim();
    if (clean === "") return;
    const now = Date.now();
    await this.brainStore.apply({
      kind: "chat.record",
      record: { id: `agent:person:${randomUUID()}`, author: "agent", text: clean, createdAt: now, updatedAt: now },
    });
  }

  async upsertLedger(input: Omit<import("../domain/types.js").LedgerEntry, "createdAt" | "updatedAt">): Promise<void> {
    const previous = (await this.brainStore.read()).ledger.find((entry) => entry.id === input.id);
    const now = Date.now();
    await this.brainStore.apply({
      kind: "ledger.upsert",
      entry: { ...input, createdAt: previous?.createdAt ?? now, updatedAt: now },
    });
  }

  /** Store an Atlas item only after Carto has freshly inspected its evidence. */
  async upsertAtlasFromFile(input: {
    id: string;
    title: string;
    claim: string;
    path: string;
    startLine: number;
    endLine: number;
    edges?: Array<{ kind: "replaces" | "depends-on" | "contradicts"; target: string }>;
  }): Promise<void> {
    const inspected = await inspectProjectFile(this.root, input);
    const previous = (await this.brainStore.read()).atlas.find((entry) => entry.id === input.id);
    const now = Date.now();
    const node: AtlasNode = {
      id: input.id,
      title: input.title.trim(),
      claim: input.claim.trim(),
      evidence: [
        {
          kind: "file",
          path: inspected.path,
          startLine: inspected.startLine,
          endLine: inspected.endLine,
          digest: inspected.digest,
          excerpt: inspected.excerpt,
          freshness: "fresh",
        },
      ],
      edges: input.edges ?? previous?.edges ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (node.title === "" || node.claim === "") throw new ProjectError("An Atlas title and claim cannot be empty.");
    await this.brainStore.apply({ kind: "atlas.upsert", node });
  }

  async armWake(input: Pick<WakeEntry, "id" | "kind" | "condition" | "reason">): Promise<void> {
    if (input.kind === "time") parseTimeWakeCondition(input.condition);
    else await resolveProjectWatchPath(this.root, input.condition);
    const previous = (await this.brainStore.read()).wakes.find((wake) => wake.id === input.id);
    await this.brainStore.apply({
      kind: "wake.upsert",
      wake: { ...input, status: "armed", createdAt: previous?.createdAt ?? Date.now() },
    });
    await this.reconcileWakes();
  }

  async cancelWake(id: string, reason = "The person cancelled this wake."): Promise<void> {
    const wake = (await this.brainStore.read()).wakes.find((candidate) => candidate.id === id);
    if (wake === undefined) throw new ProjectError(`No wake exists with id ${id}.`);
    await this.brainStore.apply({ kind: "wake.upsert", wake: { ...wake, status: "cancelled", reason } });
    await this.reconcileWakes();
  }

  async deleteChatNow(id: string): Promise<void> {
    await this.deleteNow("chat", id);
  }

  /** Interrupt stops the run at its Pi Durable boundary. Queued inputs stay queued. */
  async interruptTurn(): Promise<void> {
    if (!(await this.live.isBusy())) throw new ProjectError("There is no active turn to interrupt.");
    this.turnState = "cancelling";
    await this.live.interrupt();
    this.turnState = "idle";
  }

  /** Cancel is interrupt plus dropping the queued inputs. */
  async cancelTurn(): Promise<void> {
    if (!(await this.live.isBusy())) throw new ProjectError("There is no active turn to cancel.");
    this.turnState = "cancelling";
    await this.live.cancel();
    this.turnState = "idle";
  }

  /** Follow-up is the normal input. It is queued while the agent is working. */
  async sendUserMessage(text: string): Promise<void> {
    const completion = await this.beginSend(text, "follow-up", true);
    await completion;
  }

  /** Admit a UI input without waiting for the model stream to finish. */
  async send(text: string, mode: SendMode = "follow-up"): Promise<void> {
    await this.beginSend(text, mode, true);
  }

  private async beginSend(text: string, mode: SendMode, recordPersonChat: boolean): Promise<Promise<void>> {
    const clean = text.trim();
    if (clean === "") return Promise.resolve();
    await this.refreshEvidence();
    await this.consumeReadyWakes();
    const id = randomUUID();
    const now = Date.now();
    if (recordPersonChat) {
      await this.brainStore.apply({
        kind: "chat.record",
        record: { id: `user:${id}`, author: "user", text: clean, createdAt: now, updatedAt: now },
      });
    }
    if (mode === "interruption") {
      this.turnState = "cancelling";
      await this.live.cancel();
      this.turnState = "idle";
    }
    const durableMode = mode === "steer" ? "steer" : "followUp";
    const request = this.live.submit(clean, `user:${id}`, durableMode);
    this.trackTurn(`user:${id}`, request);
    return request;
  }

  /**
   * Continue a failed turn when Pi has work left. Otherwise start an agent turn
   * with Carto control data, not a Person Chat record.
   */
  async continueTurn(): Promise<void> {
    if (await this.live.isBusy()) throw new ProjectError("Wait for the active turn, interrupt it, or cancel it before continue.");
    const id = `continue:${randomUUID()}`;
    const request = this.live.continueOrStart(id);
    this.trackTurn(id, request);
  }

  async turnView(): Promise<TurnView> {
    return this.projectTurnView(await this.live.view());
  }

  private projectTurnView(liveView: LiveSessionView): TurnView {
    return {
      state: liveView.busy ? this.turnState : "idle",
      queued: liveView.queued,
    };
  }

  private trackTurn(id: string, work: Promise<void>): void {
    this.runningSubmissions.set(id, work);
    this.turnState = "running";
    void work
      .then(async () => {
        await this.finishTurn();
      })
      .catch((error: unknown) => {
        this.live.noteError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.runningSubmissions.delete(id);
        if (this.runningSubmissions.size === 0) this.turnState = "idle";
      });
  }

  private async finishTurn(): Promise<void> {
    await this.reconcileWakes();
    if (this.collapseRequested) {
      this.collapseRequested = false;
      await this.rotateContext();
    }
  }

  /**
   * Collapse the live context: end it, forget its transcript, keep the Brain,
   * rebuild fresh context from the Brain, seal the previous store as the
   * archive, and purge the archive that had its one collapse of grace. No
   * approval; the person triggers from the workspace, the agent from its tool.
   */
  async collapse(): Promise<void> {
    await this.rotateContext();
  }

  async close(): Promise<void> {
    try {
      await this.live.close();
    } finally {
      await this.brainStore.close();
    }
  }

  private async consumeReadyWakes(): Promise<void> {
    const ready = (await this.brainStore.read()).wakes.filter((wake) => wake.status === "ready");
    for (const wake of ready) {
      await this.brainStore.apply({ kind: "wake.upsert", wake: { ...wake, status: "consumed" } });
    }
  }

  private async reconcileWakes(): Promise<void> {
    const wakes = (await this.brainStore.read()).wakes;
    for (const wake of wakes) {
      if (wake.kind === "time") {
        if (wake.status !== "armed") await this.live.cancelTimeWake(wake.id);
        else await this.live.ensureTimeWake(wake.id, parseTimeWakeCondition(wake.condition));
        continue;
      }
      if (wake.status === "armed") await this.live.ensurePathWake(wake.id, wake.condition);
      else await this.live.cancelPathWake(wake.id);
    }
  }

  private async rotateContext(): Promise<void> {
    await this.refreshEvidence();
    const priorGeneration = this.liveGeneration;
    const discoveredArchive = (await discoverContextStores(this.root)).archive;

    const generation = randomUUID();
    const next = await LiveSession.open({
      path: contextDatabasePath(this.root, generation),
      model: parseModelRef(this.config.model),
      config: this.config,
      projectRoot: this.root,
      brain: this.brainStore,
      contextBudget: CONTEXT_BUDGET,
      promptStore: this.prompts,
      onCollapseRequest: () => {
        this.collapseRequested = true;
      },
    });
    try {
      await this.brainStore.apply({ kind: "collapse.rotate" });
    } catch (error) {
      await next.close();
      await removeGeneration(this.root, generation);
      throw error;
    }

    const priorLive = this.live;
    this.live = next;
    this.liveGeneration = generation;
    this.archivePresent = true;
    this.prompts.clear();
    const failures: unknown[] = [];
    await attemptAfterCollapse(() => priorLive.vacuum(), failures);
    await attemptAfterCollapse(() => priorLive.close(), failures);
    // The archive that was already here had its one collapse of grace with
    // this collapse. Pins-to-archive export lands with the archive tooling;
    // nothing can have been pinned to the archive yet, so the purge exports
    // nothing today.
    if (discoveredArchive !== undefined) {
      await attemptAfterCollapse(() => removeGeneration(this.root, discoveredArchive), failures);
    }
    // Seal the just-archived live store as read-only, best-effort. The open
    // path discovers stores by mtime, not by mode, so a failed chmod is a
    // tidiness problem, not a correctness one.
    await attemptAfterCollapse(() => sealGeneration(this.root, priorGeneration), failures);
    await attemptAfterCollapse(() => this.brainStore.vacuum(), failures);
    await attemptAfterCollapse(() => this.live.vacuum(), failures);
    await attemptAfterCollapse(async () => removeUnreferencedContextFiles(this.root), failures);
    await attemptAfterCollapse(() => this.reconcileWakes(), failures);
    if (failures.length > 0) throw new AggregateError(failures, "Carto completed the collapse but some cleanup could not finish.");
  }
}

async function closeOpenedProjectResources(live: LiveSession | undefined, brainStore: BrainStore): Promise<unknown[]> {
  const failures: unknown[] = [];
  try {
    await live?.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await brainStore.close();
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

async function attemptAfterCollapse(work: () => Promise<void>, failures: unknown[]): Promise<void> {
  try {
    await work();
  } catch (error) {
    failures.push(error);
  }
}

async function refreshSource(root: string, source: SourceRef): Promise<SourceRef> {
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

function hasDeletionTarget(brain: CartoBrain, target: DeletionTarget["target"], id: string): boolean {
  switch (target) {
    case "chat":
      return brain.chat.some((entry) => entry.id === id);
    case "ledger":
      return brain.ledger.some((entry) => entry.id === id);
    case "atlas":
      return brain.atlas.some((entry) => entry.id === id);
    case "user-pin":
      return brain.userPins.some((entry) => entry.id === id);
    case "carry-pin":
      return brain.carryPins.some((entry) => entry.id === id);
  }
}

interface ContextStore {
  generation: string;
  mtimeMs: number;
}

/**
 * All live context stores, newest first. This is the only record of which
 * store is which: the Brain keeps no generation pointer, so a fresh read of
 * the directory is the source of truth after any crash.
 */
async function listContextStores(root: string): Promise<ContextStore[]> {
  const directory = contextDirectory(root);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const stores: ContextStore[] = [];
  for (const name of names) {
    if (!name.endsWith(".sqlite")) continue;
    const generation = name.slice(0, -".sqlite".length);
    if (!isContextGenerationName(generation)) continue;
    try {
      const info = await stat(join(directory, name));
      if (info.isFile()) stores.push({ generation, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  stores.sort((first, second) => second.mtimeMs - first.mtimeMs);
  return stores;
}

async function discoverContextStores(root: string): Promise<{ live: string | undefined; archive: string | undefined }> {
  const stores = await listContextStores(root);
  return { live: stores[0]?.generation, archive: stores[1]?.generation };
}

/**
 * Pick the store this open should use, repairing permissions left behind by a
 * collapse that crashed part-way through sealing one. Creates a new generation
 * when there is nothing to adopt.
 */
async function adoptLiveGeneration(root: string): Promise<string> {
  const stores = await listContextStores(root);
  if (stores.length === 0) return randomUUID();
  const live = stores[0]!;
  // A store left read-only by a crashing seal cannot be opened read-write.
  await chmod(join(contextDirectory(root), `${live.generation}.sqlite`), 0o600).catch(() => {});
  return live.generation;
}

/** Best-effort: seal a retired store as read-only. Discovery never depends on the mode. */
async function sealGeneration(root: string, generation: string): Promise<void> {
  const directory = contextDirectory(root);
  for (const name of [`${generation}.sqlite`, `${generation}.sqlite-wal`, `${generation}.sqlite-shm`]) {
    await chmod(join(directory, name), 0o444).catch(() => {});
  }
}

/**
 * Delete every generation store beyond the live one and its archive: the two
 * newest survive. This is what makes a collapse idempotent after a crash.
 */
async function removeUnreferencedContextFiles(root: string): Promise<void> {
  const directory = contextDirectory(root);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const stores = await listContextStores(root);
  const keep = new Set(stores.slice(0, 2).map((store) => store.generation));
  for (const name of names) {
    if (name.endsWith(".sqlite")) {
      const generation = name.slice(0, -".sqlite".length);
      if (isContextGenerationName(generation) && !keep.has(generation)) await removeGeneration(root, generation);
      continue;
    }
    const sidecar = orphanSidecarGeneration(name);
    if (sidecar !== undefined && !keep.has(sidecar) && !names.includes(`${sidecar}.sqlite`)) {
      await rm(join(directory, name), { force: true });
    }
  }
}

function orphanSidecarGeneration(name: string): string | undefined {
  for (const suffix of [".sqlite-wal", ".sqlite-shm"]) {
    if (!name.endsWith(suffix)) continue;
    const generation = name.slice(0, -suffix.length);
    return isContextGenerationName(generation) ? generation : undefined;
  }
  return undefined;
}

async function removeGeneration(root: string, generation: string): Promise<void> {
  const path = contextDatabasePath(root, generation);
  // A store sealed read-only by a completed collapse cannot be vacuumed;
  // restore write permission first, best-effort.
  await chmod(path, 0o600).catch(() => {});
  let cleanupFailure: unknown;
  try {
    await access(path);
    const database = await openNodeSqliteDatabase(path);
    try {
      await database.exec("PRAGMA secure_delete = ON");
      await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await database.exec("VACUUM");
      await database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      await database.close();
    }
  } catch (error) {
    if (!isMissingFile(error)) cleanupFailure = error;
  }
  await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
