import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

import { mergeCarryPins, projectContext } from "../domain/context.js";
import { ensureHandles, resolveHandle, resolveHandleOfKind } from "../domain/handles.js";
import type {
  AtlasNode,
  CarryPin,
  ChangeProposal,
  DeletionTarget,
  CartoBrain,
  Handoff,
  SourceRef,
  WakeEntry,
} from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import type { CollapseMode, GlobalConfig } from "./config.js";
import { parseModelRef } from "./config.js";
import { CONTEXT_BUDGET, LiveSession, type LiveActivity, type LiveSessionView } from "./live-session.js";
import { parseUnifiedPatch } from "./patch.js";
import { brainDatabasePath, contextDatabasePath, contextDirectory, isContextGenerationName } from "./paths.js";
import { parseTimeWakeCondition } from "./wake.js";
import { digestProjectFile, inspectProjectFile, resolveProjectWatchPath } from "./workspace.js";

export class ProjectError extends Error {}

export interface ProjectView {
  brain: CartoBrain;
  context: ReturnType<typeof projectContext>;
  liveCarryPins: CarryPin[];
  turn: TurnView;
  activity: LiveActivity[];
}

export type SendMode = "interruption" | "steer" | "follow-up";

export interface TurnView {
  state: "idle" | "running" | "paused" | "cancelling";
  pausedDraft: string | null;
  queued: Array<{ id: string; mode: "steer" | "follow-up"; text: string }>;
}

export class CartoProject {
  private applyingChanges = false;
  private readonly pausedDrafts = new Map<string, string>();
  private readonly runningSubmissions = new Map<string, Promise<void>>();
  private turnState: TurnView["state"] = "idle";

  private constructor(
    readonly root: string,
    readonly config: GlobalConfig,
    private readonly brainStore: BrainStore,
    private live: LiveSession,
  ) {}

  static async open(root: string, config: GlobalConfig): Promise<CartoProject> {
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
        config,
        projectRoot: root,
        brain: brainStore,
        contextBudget: CONTEXT_BUDGET,
      });
      if (brain.context.liveGeneration === null) {
        await brainStore.apply({ kind: "context.initialize", liveGeneration: generation });
      }
      const project = new CartoProject(root, config, brainStore, live);
      await project.refreshEvidence();
      await project.syncHandles();
      await project.reconcileWakes();
      await project.reconcileApprovedChanges();
      return project;
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
  async view(): Promise<ProjectView> {
    const [brain, liveCarryPins, liveView] = await Promise.all([this.brainStore.read(), this.live.liveCarryPins(), this.live.view()]);
    return {
      brain,
      context: projectContext(brain, {
        budget: CONTEXT_BUDGET,
        carryPins: mergeCarryPins(liveCarryPins, brain.carryPins),
      }),
      liveCarryPins,
      turn: this.projectTurnView(liveView),
      activity: liveView.activity,
    };
  }

  /**
   * Keep the private handle table in step with the live generation's carry
   * pins. No handle is renumbered here; a collapse rebuilds the whole table.
   */
  /**
   * A cheap view for a frame that the spinner clock asked for: the live
   * documents, the Brain, and the projection, without the transcript. The
   * transcript only changes when a run writes an entry, which arrives as a
   * commit, and a commit asks for a full read of its own.
   */
  async liveFrameView(): Promise<ProjectView> {
    const [brain, liveCarryPins, liveView] = await Promise.all([this.brainStore.read(), this.live.liveCarryPins(), this.live.liveView()]);
    return {
      brain,
      context: projectContext(brain, {
        budget: CONTEXT_BUDGET,
        carryPins: mergeCarryPins(liveCarryPins, brain.carryPins),
      }),
      liveCarryPins,
      turn: this.projectTurnView({ ...liveView, activity: [] }),
      activity: liveView.activity,
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

  async syncHandles(): Promise<void> {
    const [brain, liveCarryPins] = await Promise.all([this.brainStore.read(), this.live.liveCarryPins()]);
    const carryPins = mergeCarryPins(liveCarryPins, brain.carryPins);
    // Do not write the Brain when the table already covers every record. The UI
    // calls this on a timer, so a needless commit would churn SQLite.
    if (sameJson(ensureHandles(brain.handles, brain, carryPins), brain.handles)) return;
    await this.brainStore.apply({ kind: "handles.sync", carryPins });
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
    await this.syncHandles();
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

  /** The normal pin-removal path is deferred to the next collapse. */
  /** @internal: use removePinHandleAtCollapse from UI or tools. */
  private async removeUserPin(id: string): Promise<void> {
    await this.brainStore.apply({ kind: "pin.user.remove", id, markedAt: Date.now() });
  }

  /** Remove a user pin now and restart from a fresh prefill. */
  private async removeUserPinNow(id: string): Promise<void> {
    await this.removeNow({ target: "user-pin", id });
  }

  private async removeCarryPin(id: string): Promise<void> {
    const brain = await this.brainStore.read();
    if (brain.carryPins.some((pin) => pin.id === id)) {
      await this.brainStore.apply({ kind: "pin.carry.remove", id, markedAt: Date.now() });
      return;
    }
    if ((await this.live.liveCarryPins()).some((pin) => pin.id === id)) {
      // A carry pin from the current live generation expires at collapse. Keep a
      // visible mark until then so the person can undo this safe deferred action.
      await this.brainStore.apply({ kind: "deletion.mark", mark: { target: "carry-pin", id, markedAt: Date.now() } });
      return;
    }
    throw new ProjectError(`No carry pin exists with id ${id}.`);
  }

  private async removeCarryPinNow(id: string): Promise<void> {
    await this.removeNow({ target: "carry-pin", id });
  }

  /** Remove either type of pin. The Context tab does not expose private pin types. */
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

  /** Defer one removal to the next collapse, selected by its short handle. */
  async markHandleForDeletion(handle: string): Promise<void> {
    const target = await this.deletionTargetFor(handle);
    await this.markForDeletion(target.target, target.id);
  }

  /** Remove now and restart live context from a fresh prefill. */
  async deleteHandleNow(handle: string): Promise<void> {
    const target = await this.deletionTargetFor(handle);
    await this.removeNow(target);
  }

  /** Cancel a deferred removal, selected by its short handle. */
  async undeleteHandle(handle: string): Promise<void> {
    const target = await this.deletionTargetFor(handle);
    await this.cancelDeletion(target.target, target.id);
  }

  /** Remove a pin now, selected by its short handle. */
  async removePinHandleNow(handle: string): Promise<void> {
    const resolved = await this.resolveTarget(handle, ["pin"]);
    await this.removeNow({ target: await this.pinTarget(resolved.id), id: resolved.id });
  }

  /** Defer a pin removal to the next collapse, selected by its short handle. */
  async removePinHandleAtCollapse(handle: string): Promise<void> {
    const resolved = await this.resolveTarget(handle, ["pin"]);
    await this.markForDeletion(await this.pinTarget(resolved.id), resolved.id);
  }

  /** A pin handle can name either a user pin or a carry pin. */
  async pinTarget(id: string): Promise<"user-pin" | "carry-pin"> {
    const brain = await this.brainStore.read();
    if (brain.userPins.some((pin) => pin.id === id)) return "user-pin";
    const liveCarryPins = await this.live.liveCarryPins();
    if (mergeCarryPins(liveCarryPins, brain.carryPins).some((pin) => pin.id === id)) return "carry-pin";
    throw new ProjectError("No pin exists with that handle.");
  }

  async markForDeletion(target: DeletionTarget["target"], id: string): Promise<void> {
    await this.brainStore.apply({ kind: "deletion.mark", mark: { target, id, markedAt: Date.now() } });
  }

  async deleteNow(target: DeletionTarget["target"], id: string): Promise<void> {
    await this.removeNow({ target, id });
  }

  async cancelDeletion(target: DeletionTarget["target"], id: string): Promise<void> {
    await this.brainStore.apply({ kind: "deletion.unmark", target: { target, id } });
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
    links?: string[];
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
      links: input.links ?? previous?.links ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    if (node.title === "" || node.claim === "") throw new ProjectError("An Atlas title and claim cannot be empty.");
    await this.brainStore.apply({ kind: "atlas.upsert", node });
  }

  async setHandoff(input: Omit<Handoff, "updatedAt"> | null): Promise<void> {
    if (input === null) {
      await this.brainStore.apply({ kind: "handoff.set", handoff: null });
      return;
    }
    if (input.intent.trim() === "" || input.nextAction.trim() === "") {
      throw new ProjectError("A handoff needs an intent and a next action.");
    }
    await this.brainStore.apply({ kind: "handoff.set", handoff: { ...input, updatedAt: Date.now() } });
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
    await this.removeNow({ target: "chat", id });
  }

  async deleteChatAtCollapse(id: string): Promise<void> {
    await this.markForDeletion("chat", id);
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
    if ((await this.brainStore.read()).activity.kind === "waiting-for-collapse") {
      throw new ProjectError("Confirm or cancel the requested collapse before you send another message.");
    }
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

  /** Stop at a Pi Durable boundary. The preserved partial is an editable draft. */
  async pauseTurn(): Promise<void> {
    if (!(await this.live.isBusy())) throw new ProjectError("There is no active turn to pause.");
    this.turnState = "cancelling";
    const draft = await this.live.pause();
    if (draft !== "") this.pausedDrafts.set("current", draft);
    this.turnState = "paused";
    await this.brainStore.apply({ kind: "activity.set", activity: { kind: "idle", detail: "Turn paused. Edit the continuation draft or resume." } });
  }

  async resumeTurn(text?: string): Promise<void> {
    const draft = (text ?? this.pausedDrafts.get("current") ?? "").trim();
    if (this.turnState !== "paused") throw new ProjectError("There is no paused turn to resume.");
    this.pausedDrafts.delete("current");
    this.turnState = "idle";
    if (draft === "") {
      await this.continueTurn();
      return;
    }
    const id = `resume:${randomUUID()}`;
    const request = this.live.resumeFromDraft(draft, id);
    this.trackTurn(id, request);
  }

  async cancelTurn(): Promise<void> {
    if (!(await this.live.isBusy()) && this.turnState !== "paused") throw new ProjectError("There is no active or paused turn to cancel.");
    this.turnState = "cancelling";
    await this.live.cancel();
    this.pausedDrafts.clear();
    this.turnState = "idle";
    await this.brainStore.apply({ kind: "activity.set", activity: { kind: "idle", detail: null } });
  }

  /**
   * Continue a failed turn when Pi has work left. Otherwise start an agent turn
   * with Carto control data, not a Person Chat record.
   */
  async continueTurn(): Promise<void> {
    if (await this.live.isBusy()) throw new ProjectError("Wait for the active turn, pause it, or cancel it before continue.");
    const id = `continue:${randomUUID()}`;
    const request = this.live.continueOrStart(id);
    this.trackTurn(id, request);
  }

  async turnView(): Promise<TurnView> {
    return this.projectTurnView(await this.live.view());
  }

  private projectTurnView(liveView: LiveSessionView): TurnView {
    return {
      state: this.turnState === "paused" ? "paused" : liveView.busy ? this.turnState : "idle",
      pausedDraft: this.pausedDrafts.get("current") ?? null,
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
      .catch(async (error: unknown) => {
        await this.brainStore.apply({
          kind: "activity.set",
          activity: { kind: "error", detail: error instanceof Error ? error.message : String(error) },
        });
      })
      .finally(() => {
        this.runningSubmissions.delete(id);
        if (this.runningSubmissions.size === 0 && this.turnState !== "paused") this.turnState = "idle";
      });
  }

  private async finishTurn(): Promise<void> {
    await this.reconcileWakes();
    await this.reconcileApprovedChanges();
    const requested = await this.brainStore.read();
    if (this.config.collapseMode === "agent" && requested.activity.kind === "waiting-for-collapse") await this.rotateContext();
    const brain = await this.brainStore.read();
    if (brain.activity.kind === "thinking") await this.brainStore.apply({ kind: "activity.set", activity: { kind: "idle", detail: null } });
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

  private async removeNow(target: DeletionTarget): Promise<void> {
    const [before, liveCarryPins] = await Promise.all([this.brainStore.read(), this.live.liveCarryPins()]);
    if (!hasDeletionTarget(before, liveCarryPins, target)) {
      throw new ProjectError(`No ${target.target} exists with id ${target.id}.`);
    }
    await this.live.cancel();
    this.pausedDrafts.clear();
    this.turnState = "idle";
    await this.brainStore.apply({ kind: "deletion.now", target });

    // A fresh session is necessary: Pi Durable cannot subtract arbitrary old
    // transcript context from a provider request. Preserve only carry pins that
    // are not the target. The old live and archive files are discarded by the
    // restart decision, then securely cleaned up.
    const nextCarryPins = mergeCarryPins(liveCarryPins, before.carryPins).filter(
      (pin) => target.target !== "carry-pin" || pin.id !== target.id,
    );
    await this.restartLiveContext(nextCarryPins);
  }

  private async restartLiveContext(initialCarryPins: CarryPin[]): Promise<void> {
    const old = this.live;
    const generation = randomUUID();
    const next = await LiveSession.open({
      path: contextDatabasePath(this.root, generation),
      model: parseModelRef(this.config.model),
      config: this.config,
      projectRoot: this.root,
      brain: this.brainStore,
      contextBudget: CONTEXT_BUDGET,
      initialCarryPins,
    });
    try {
      const decision = await this.brainStore.apply({ kind: "context.restart", newLiveGeneration: generation });
      this.live = next;
      const failures: unknown[] = [];
      await attemptAfterCollapse(() => this.syncHandles(), failures);
      await attemptAfterCollapse(() => old.close(), failures);
      for (const effect of decision.effects) {
        if (effect.kind === "discard-context" || effect.kind === "remove-archive") {
          await attemptAfterCollapse(() => removeGeneration(this.root, effect.generation), failures);
        }
      }
      await attemptAfterCollapse(() => this.brainStore.vacuum(), failures);
      await attemptAfterCollapse(() => this.live.vacuum(), failures);
      await attemptAfterCollapse(async () => removeUnreferencedContextFiles(this.root, await this.brainStore.read()), failures);
      if (failures.length > 0) {
        throw new AggregateError(failures, "Carto restarted context but some immediate-removal cleanup could not finish.");
      }
    } catch (error) {
      // Once the new Brain generation commits, `next` is the valid live session.
      // Do not remove it in that case. A later open will retry unreferenced-file
      // cleanup. Before that commit, remove the unused candidate generation.
      const brain = await this.brainStore.read();
      if (brain.context.liveGeneration !== generation) {
        await next.close();
        await removeGeneration(this.root, generation);
      }
      throw error;
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
      config: this.config,
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
    await attemptAfterCollapse(() => this.syncHandles(), failures);
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

function hasDeletionTarget(brain: CartoBrain, liveCarryPins: readonly CarryPin[], target: DeletionTarget): boolean {
  switch (target.target) {
    case "chat":
      return brain.chat.some((entry) => entry.id === target.id);
    case "ledger":
      return brain.ledger.some((entry) => entry.id === target.id);
    case "atlas":
      return brain.atlas.some((entry) => entry.id === target.id);
    case "user-pin":
      return brain.userPins.some((entry) => entry.id === target.id);
    case "carry-pin":
      return brain.carryPins.some((entry) => entry.id === target.id) || liveCarryPins.some((entry) => entry.id === target.id);
  }
}

async function ensureReferencedContextFiles(root: string, brain: CartoBrain): Promise<void> {
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
        throw new ProjectError(`The referenced ${role} context is missing: ${path}. Carto will not replace it with an empty session.`);
      }
      throw error;
    }
  }
}

async function removeUnreferencedContextFiles(root: string, brain: CartoBrain): Promise<void> {
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
