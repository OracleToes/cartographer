import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import { createEmptyBrain } from "../domain/brain.js";
import { decide, type Decision, type CartoCommand } from "../domain/commands.js";
import type { CartoBrain } from "../domain/types.js";

type StoredBrain = Record<string, JsonValue>;

const BrainDocument = defineDoc<StoredBrain>({
  kind: "carto.brain",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => createEmptyBrain() as unknown as StoredBrain,
  checkpointWhen: () => true,
});

export class BrainStore {
  private constructor(
    private readonly harness: Harness,
    private readonly root: Awaited<ReturnType<Harness["root"]>>,
    private readonly database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
  ) {}

  static async open(path: string): Promise<BrainStore> {
    await mkdir(dirname(path), { recursive: true });
    const database = await openNodeSqliteDatabase(path);
    let harness: Harness | undefined;
    try {
      await database.exec("PRAGMA secure_delete = ON");
      const storage = await SqliteStorage.open(database, { prefix: "carto_" });
      harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
      const root = await harness.root(BACKGROUND_CONTEXT);
      const store = new BrainStore(harness, root, database);
      await store.ensureDocument();
      return store;
    } catch (error) {
      if (harness === undefined) await database.close();
      else await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  async read(): Promise<CartoBrain> {
    const brain = await this.harness.snapshot(BrainDocument, this.root.id, BACKGROUND_CONTEXT);
    return copyBrain(brain ?? createEmptyBrain());
  }

  async apply(command: CartoCommand): Promise<Decision> {
    let result: Decision | undefined;
    await this.root.commit(async (transaction) => {
      const document = await transaction.doc(BrainDocument, this.root.id);
      result = decide(copyBrain(document), command);
      Object.assign(document, result.brain as unknown as StoredBrain);
    }, BACKGROUND_CONTEXT);
    if (result === undefined) throw new Error("Carto Brain command did not produce a result.");
    return result;
  }

  async vacuum(): Promise<void> {
    await this.database.exec("PRAGMA secure_delete = ON");
    await this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await this.database.exec("VACUUM");
    await this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT);
  }

  private async ensureDocument(): Promise<void> {
    await this.root.commit(async (transaction) => {
      await transaction.doc(BrainDocument, this.root.id);
    }, BACKGROUND_CONTEXT);
  }
}

function copyBrain(value: unknown): CartoBrain {
  const brain = JSON.parse(JSON.stringify(value)) as CartoBrain;
  // Version-one Carto records did not have editable Chat timestamps. Upgrade
  // this in memory; the next normal Brain write persists the compatible form.
  brain.chat = brain.chat.map((record) => ({
    ...record,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : record.createdAt,
  }));
  return brain;
}
