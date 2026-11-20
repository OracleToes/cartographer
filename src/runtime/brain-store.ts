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

/** One committed Brain write, as a signal source for the state block. */
export interface BrainWrite {
  /** The command that was applied. */
  command: CartoCommand;
  /** The Brain before the command, as a plain snapshot. */
  before: CartoBrain;
  /** The Brain after the command, as a plain snapshot. */
  after: CartoBrain;
}

export class BrainStore {
  private constructor(
    private readonly harness: Harness,
    private readonly root: Awaited<ReturnType<Harness["root"]>>,
    private readonly database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>,
    private listener: ((write: BrainWrite) => void) | undefined = undefined,
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
    let before: CartoBrain | undefined;
    await this.root.commit(async (transaction) => {
      const document = await transaction.doc(BrainDocument, this.root.id);
      before = copyBrain(document);
      result = decide(before, command);
      Object.assign(document, result.brain as unknown as StoredBrain);
    }, BACKGROUND_CONTEXT);
    if (result === undefined || before === undefined) throw new Error("Carto Brain command did not produce a result.");
    const decision = result as Decision;
    const prior = before as CartoBrain;
    try {
      this.listener?.({ command, before: prior, after: decision.brain });
    } catch {
      // A metrics signal must never turn a committed write into an error.
    }
    return decision;
  }

  /**
   * Observe every committed write. The listener is a signal tap for the
   * state block's pending list; it never sees a failed command, and its
   * errors are deliberately swallowed — a metrics signal must never turn a
   * committed Brain write into an error.
   */
  setListener(listener: ((write: BrainWrite) => void) | undefined): void {
    this.listener = listener;
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
  // Version-one Carto records did not store a handle table. Start an empty one;
  // the first decision fills it without a duplicate commit.
  if (brain.handles === undefined || !Array.isArray(brain.handles.entries)) {
    brain.handles = { counters: {}, entries: [] };
  }
  return brain;
}
