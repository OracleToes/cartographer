import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import { BrainStore } from "./brain-store.js";
import type { ModelRef } from "./config.js";
import { createMiniExtension } from "./mini-extension.js";

const MINI_INSTRUCTIONS = [
  "Use the chat tool for every message to the person.",
  "Do not treat plain model text as a person-facing message.",
  "Inspect before you make a claim about a project file.",
  "Use Ledger and Atlas for durable records.",
  "Propose a change before an approved patch applies it.",
].join("\n");

export interface LiveSessionOptions {
  path: string;
  model: ModelRef;
  projectRoot: string;
  brain: BrainStore;
  seedContext?: string;
}

export class LiveSession {
  private constructor(
    private readonly harness: Harness,
    private readonly root: Awaited<ReturnType<Harness["root"]>>,
    private readonly database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
  ) {}

  static async open(options: LiveSessionOptions): Promise<LiveSession> {
    await mkdir(dirname(options.path), { recursive: true });
    const database = await openNodeSqliteDatabase(options.path);
    await database.exec("PRAGMA secure_delete = ON");
    const storage = await SqliteStorage.open(database, { prefix: "live_" });
    const models = builtinModels();
    if (models.getModel(options.model.provider, options.model.modelId) === undefined) {
      await database.close();
      throw new Error(`Pi does not know the model ${options.model.provider}/${options.model.modelId}.`);
    }

    const registry = createRegistry();
    registry.install(
      createMiniExtension({
        brain: options.brain,
        projectRoot: options.projectRoot,
      }),
    );

    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT);
    const agent = {
      model: options.model,
      instructions: renderInstructions(options.seedContext),
      compaction: { enabled: false },
      maxTurns: 16,
    };
    const root = await harness.root(BACKGROUND_CONTEXT, { agent });
    if (options.seedContext === undefined) {
      await root.configure({ model: options.model, compaction: { enabled: false }, maxTurns: 16 }, BACKGROUND_CONTEXT);
    }
    harness.resume();
    return new LiveSession(harness, root, database);
  }

  async submit(text: string, requestId: string) {
    const submission = await this.root.submit({ type: "input", content: text, requestId }, BACKGROUND_CONTEXT);
    return submission.wait(BACKGROUND_CONTEXT);
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

function renderInstructions(seedContext: string | undefined): string {
  if (seedContext === undefined || seedContext === "") return MINI_INSTRUCTIONS;
  return `${MINI_INSTRUCTIONS}\n\nContext for this live generation:\n${seedContext}`;
}
