import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { mergeCarryPins, projectContext } from "../domain/context.js";
import type { CarryPin, ChangeProposal, DeletionTarget, MiniBrain, SourceRef } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import type { CollapseMode, GlobalConfig } from "./config.js";
import { parseModelRef } from "./config.js";
import { CONTEXT_BUDGET, LiveSession } from "./live-session.js";
import { parseUnifiedPatch } from "./patch.js";
import { brainDatabasePath, contextDatabasePath, contextDirectory, isContextGenerationName } from "./paths.js";
import { parseTimeWakeCondition } from "./wake.js";
import { digestProjectFile, inspectProjectFile } from "./workspace.js";

export class ProjectError extends Error {}

export interface ProjectView {
  brain: MiniBrain;
  context: ReturnType<typeof projectContext>;
  liveCarryPins: CarryPin[];
}

export class MiniProject {
  private applyingChanges = false;

  private constructor(
    readonly root: string,
    readonly config: GlobalConfig,
    private readonly brainStore: BrainStore,
    private live: LiveSession,
  ) {}

  static async open(root: string, config: GlobalConfig): Promise<MiniProject> {
    await mkdir(contextDirectory(root), { recursive: true });
    const brainStore = await BrainStore.open(brainDatabasePath(root));
    let live: LiveSession | undefined;
    try {
      const brain = await brainStore.read();
      await removeUnreferencedContextFiles(root, brain);
      await ensureReferencedContextFiles(root, brain);
      const model = parseModelRef(config.model);
      const generation = brain.context.liveGeneration ?? randomUUID();
      live = await LiveSession.open({
        path: contextDatabasePath(root, generation),
        model,
        projectRoot: root,
        brain: brainStore,
        contextBudget: CONTEXT_BUDGET,
      });
      if (brain.context.liveGeneration === null) {
        await brainStore.apply({ kind: "context.initialize", liveGeneration: generation });
      }
      const project = new MiniProject(root, config, brainStore, live);
      await project.refreshEvidence();
      await project.reconcileWakes();
      await project.reconcileApprovedChanges();
      return project;
    } catch (error) {
      const cleanupFailures = await closeOpenedProjectResources(live, brainStore);
      if (cleanupFailures.length > 0) {
        throw new AggregateError([error, ...cleanupFailures], "Mini could not finish opening the project.");
      }
      throw error;
    }
  }

  async view(): Promise<ProjectView> {
    const brain = await this.brainStore.read();
    const liveCarryPins = await this.live.liveCarryPins();
    return {
      brain,
      context: projectContext(brain, {
        budget: CONTEXT_BUDGET,
        carryPins: mergeCarryPins(liveCarryPins, brain.carryPins),
      }),
      liveCarryPins,
    };
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
    await this.live.refreshCarryPins();
  }

  async addUserContextPin(item: string, reason: string): Promise<void> {
    const brain = await this.brainStore.read();
    const contextId = brain.context.archiveGeneration ?? brain.context.liveGeneration;
    if (contextId === null) throw new ProjectError("There is no context generation to pin.");
    const source: SourceRef = { kind: "context", contextId, excerpt: item, freshness: "fresh" };
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

  async removeUserPin(id: string): Promise<void> {
    await this.brainStore.apply({ kind: "pin.user.remove", id });
  }

  async markForDeletion(target: DeletionTarget["target"], id: string): Promise<void> {
    await this.brainStore.apply({ kind: "deletion.mark", mark: { target, id, markedAt: Date.now() } });
  }

  async cancelDeletion(target: DeletionTarget["target"], id: string): Promise<void> {
    await this.brainStore.apply({ kind: "deletion.unmark", target: { target, id } });
  }

  async recordChangeProposal(change: ChangeProposal): Promise<void> {
    if (change.status !== "proposed" || change.resolvedAt !== null) {
      throw new ProjectError("A new change proposal must have proposed status and no resolution time.");
    }
    parseUnifiedPatch(change.patch);
    await this.brainStore.apply({ kind: "change.upsert", change });
  }

  async approveChange(id: string): Promise<void> {
    const change = await this.findChange(id);
    if (change.status !== "proposed") throw new ProjectError(`Only a proposed change can be approved: ${id}.`);
    await this.brainStore.apply({
      kind: "change.upsert",
      change: { ...change, status: "approved", resolvedAt: null },
    });
    await this.reconcileApprovedChanges();
  }

  async rejectChange(id: string): Promise<void> {
    const change = await this.findChange(id);
    if (change.status !== "proposed") throw new ProjectError(`Only a proposed change can be rejected: ${id}.`);
    await this.brainStore.apply({
      kind: "change.upsert",
      change: { ...change, status: "rejected", resolvedAt: Date.now() },
    });
  }

  async sendUserMessage(text: string): Promise<void> {
    const clean = text.trim();
    if (clean === "") return;
    if ((await this.brainStore.read()).activity.kind === "waiting-for-collapse") {
      throw new ProjectError("Confirm or cancel the requested collapse before you send another message.");
    }
    await this.refreshEvidence();
    await this.consumeReadyWakes();
    const id = randomUUID();
    await this.brainStore.apply({
      kind: "chat.record",
      record: { id: `user:${id}`, author: "user", text: clean, createdAt: Date.now() },
    });
    await this.brainStore.apply({ kind: "activity.set", activity: { kind: "thinking", detail: null } });
    try {
      await this.live.submit(clean, `user:${id}`);
      await this.reconcileWakes();
      await this.reconcileApprovedChanges();
      const requested = await this.brainStore.read();
      if (this.config.collapseMode === "agent" && requested.activity.kind === "waiting-for-collapse") {
        await this.rotateContext();
      }
      const brain = await this.brainStore.read();
      if (brain.activity.kind === "thinking") {
        await this.brainStore.apply({ kind: "activity.set", activity: { kind: "idle", detail: null } });
      }
    } catch (error) {
      await this.brainStore.apply({
        kind: "activity.set",
        activity: { kind: "error", detail: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  async requestCollapse(detail = "The person requested a context collapse."): Promise<void> {
    await this.brainStore.apply({ kind: "collapse.request", detail });
    if (this.config.collapseMode === "agent") await this.rotateContext();
  }

  async collapse(): Promise<void> {
    if (this.config.collapseMode === "request") {
      throw new ProjectError("The default collapse mode needs a confirmed collapse.");
    }
    await this.rotateContext();
  }

  async confirmCollapse(): Promise<void> {
    if ((await this.brainStore.read()).activity.kind !== "waiting-for-collapse") {
      throw new ProjectError("There is no pending collapse request to confirm.");
    }
    await this.rotateContext();
  }

  async cancelCollapse(): Promise<void> {
    if ((await this.brainStore.read()).activity.kind !== "waiting-for-collapse") {
      throw new ProjectError("There is no pending collapse request to cancel.");
    }
    await this.brainStore.apply({ kind: "activity.set", activity: { kind: "idle", detail: null } });
  }

  async close(): Promise<void> {
    try {
      await this.live.close();
    } finally {
      await this.brainStore.close();
    }
  }

  private async findChange(id: string): Promise<ChangeProposal> {
    const change = (await this.brainStore.read()).changes.find((candidate) => candidate.id === id);
    if (change === undefined) throw new ProjectError(`No change exists with id ${id}.`);
    return change;
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

  private async reconcileApprovedChanges(): Promise<void> {
    if (this.applyingChanges) return;
    this.applyingChanges = true;
    try {
      while (true) {
        const change = (await this.brainStore.read()).changes.find((candidate) => candidate.status === "approved");
        if (change === undefined) return;
        await this.live.ensurePatchApply(change.id);
      }
    } finally {
      this.applyingChanges = false;
    }
  }

  private async rotateContext(): Promise<void> {
    await this.refreshEvidence();
    const before = await this.brainStore.read();
    const oldLive = before.context.liveGeneration;
    if (oldLive === null) throw new ProjectError("There is no live context to collapse.");

    const generation = randomUUID();
    const next = await LiveSession.open({
      path: contextDatabasePath(this.root, generation),
      model: parseModelRef(this.config.model),
      projectRoot: this.root,
      brain: this.brainStore,
      contextBudget: CONTEXT_BUDGET,
      initialCarryPins: before.carryPins,
    });

    let decision;
    try {
      decision = await this.brainStore.apply({ kind: "collapse.rotate", newLiveGeneration: generation });
    } catch (error) {
      await next.close();
      await removeGeneration(this.root, generation);
      throw error;
    }

    const priorLive = this.live;
    this.live = next;
    const failures: unknown[] = [];
    await attemptAfterCollapse(() => priorLive.vacuum(), failures);
    await attemptAfterCollapse(() => priorLive.close(), failures);

    for (const effect of decision.effects) {
      if (effect.kind === "remove-archive") await attemptAfterCollapse(() => removeGeneration(this.root, effect.generation), failures);
    }
    await attemptAfterCollapse(() => this.brainStore.vacuum(), failures);
    await attemptAfterCollapse(() => this.live.vacuum(), failures);
    await attemptAfterCollapse(async () => removeUnreferencedContextFiles(this.root, await this.brainStore.read()), failures);
    await attemptAfterCollapse(() => this.reconcileWakes(), failures);
    await attemptAfterCollapse(() => this.reconcileApprovedChanges(), failures);
    if (failures.length > 0) throw new AggregateError(failures, "Mini completed the collapse but some cleanup could not finish.");
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

export function collapseNeedsConfirmation(mode: CollapseMode): boolean {
  return mode === "request";
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

async function ensureReferencedContextFiles(root: string, brain: MiniBrain): Promise<void> {
  for (const [role, generation] of [
    ["live", brain.context.liveGeneration],
    ["archive", brain.context.archiveGeneration],
  ] as const) {
    if (generation === null) continue;
    const path = contextDatabasePath(root, generation);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ProjectError(`The referenced ${role} context is not a regular file: ${path}.`);
      }
    } catch (error) {
      if (isMissingFile(error)) {
        throw new ProjectError(`The referenced ${role} context is missing: ${path}. Mini will not replace it with an empty session.`);
      }
      throw error;
    }
  }
}

async function removeUnreferencedContextFiles(root: string, brain: MiniBrain): Promise<void> {
  const directory = contextDirectory(root);
  const keep = new Set([brain.context.liveGeneration, brain.context.archiveGeneration].filter((id): id is string => id !== null));
  const files = await readdir(directory, { withFileTypes: true });
  const names = new Set(files.map((file) => file.name));
  await Promise.all([
    ...files
      .filter((file) => file.isFile() && file.name.endsWith(".sqlite"))
      .map(async (file) => {
        const id = file.name.slice(0, -".sqlite".length);
        if (isContextGenerationName(id) && !keep.has(id)) await removeGeneration(root, id);
      }),
    ...files
      .filter((file) => file.isFile())
      .map(async (file) => {
        const id = orphanSidecarGeneration(file.name);
        if (id !== undefined && !keep.has(id) && !names.has(`${id}.sqlite`)) {
          await rm(join(directory, file.name), { force: true });
        }
      }),
  ]);
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
