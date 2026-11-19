import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";

import { projectContext, renderContextPlan } from "../domain/context.js";
import type { MiniBrain } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import type { CollapseMode, GlobalConfig } from "./config.js";
import { parseModelRef } from "./config.js";
import { LiveSession } from "./live-session.js";
import { brainDatabasePath, contextDatabasePath, contextDirectory } from "./paths.js";

const CONTEXT_BUDGET = 16_000;

export class ProjectError extends Error {}

export interface ProjectView {
  brain: MiniBrain;
  context: ReturnType<typeof projectContext>;
}

export class MiniProject {
  private constructor(
    readonly root: string,
    readonly config: GlobalConfig,
    private readonly brainStore: BrainStore,
    private live: LiveSession,
  ) {}

  static async open(root: string, config: GlobalConfig): Promise<MiniProject> {
    await mkdir(contextDirectory(root), { recursive: true });
    const brainStore = await BrainStore.open(brainDatabasePath(root));
    try {
      const brain = await brainStore.read();
      await removeUnreferencedContextFiles(root, brain);
      const model = parseModelRef(config.model);

      if (brain.context.liveGeneration === null) {
        const generation = randomUUID();
        const seed = renderContextPlan(projectContext(brain, { budget: CONTEXT_BUDGET }));
        const live = await LiveSession.open({
          path: contextDatabasePath(root, generation),
          model,
          projectRoot: root,
          brain: brainStore,
          seedContext: seed,
        });
        try {
          await brainStore.apply({ kind: "context.initialize", liveGeneration: generation });
        } catch (error) {
          await live.close();
          throw error;
        }
        return new MiniProject(root, config, brainStore, live);
      }

      const live = await LiveSession.open({
        path: contextDatabasePath(root, brain.context.liveGeneration),
        model,
        projectRoot: root,
        brain: brainStore,
      });
      return new MiniProject(root, config, brainStore, live);
    } catch (error) {
      await brainStore.close();
      throw error;
    }
  }

  async view(): Promise<ProjectView> {
    const brain = await this.brainStore.read();
    return { brain, context: projectContext(brain, { budget: CONTEXT_BUDGET }) };
  }

  async sendUserMessage(text: string): Promise<void> {
    const clean = text.trim();
    if (clean === "") return;
    const id = randomUUID();
    await this.brainStore.apply({
      kind: "chat.record",
      record: { id: `user:${id}`, author: "user", text: clean, createdAt: Date.now() },
    });
    await this.brainStore.apply({ kind: "activity.set", activity: { kind: "thinking", detail: null } });
    try {
      await this.live.submit(clean, `user:${id}`);
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
  }

  async collapse(): Promise<void> {
    if (this.config.collapseMode === "request") {
      throw new ProjectError("The default collapse mode needs a confirmed collapse.");
    }
    await this.rotateContext();
  }

  async confirmCollapse(): Promise<void> {
    await this.rotateContext();
  }

  async close(): Promise<void> {
    await this.live.close();
    await this.brainStore.close();
  }

  private async rotateContext(): Promise<void> {
    const before = await this.brainStore.read();
    const oldLive = before.context.liveGeneration;
    if (oldLive === null) throw new ProjectError("There is no live context to collapse.");

    const generation = randomUUID();
    const seed = renderContextPlan(projectContext(before, { budget: CONTEXT_BUDGET }));
    const next = await LiveSession.open({
      path: contextDatabasePath(this.root, generation),
      model: parseModelRef(this.config.model),
      projectRoot: this.root,
      brain: this.brainStore,
      seedContext: seed,
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
    await priorLive.vacuum();
    await priorLive.close();

    for (const effect of decision.effects) {
      if (effect.kind === "remove-archive") await removeGeneration(this.root, effect.generation);
    }
    await this.brainStore.vacuum();
    await this.live.vacuum();
    await removeUnreferencedContextFiles(this.root, await this.brainStore.read());
  }
}

export function collapseNeedsConfirmation(mode: CollapseMode): boolean {
  return mode === "request";
}

async function removeUnreferencedContextFiles(root: string, brain: MiniBrain): Promise<void> {
  const directory = contextDirectory(root);
  const keep = new Set([brain.context.liveGeneration, brain.context.archiveGeneration].filter((id): id is string => id !== null));
  const files = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    files
      .filter((file) => file.isFile() && file.name.endsWith(".sqlite"))
      .map(async (file) => {
        const id = file.name.slice(0, -".sqlite".length);
        if (!keep.has(id)) await removeGeneration(root, id);
      }),
  );
}

async function removeGeneration(root: string, generation: string): Promise<void> {
  const path = contextDatabasePath(root, generation);
  await Promise.all([rm(path, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
}
