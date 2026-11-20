/**
 * The live session (MINI.md §4, §5, §6, §12; docs/intent.md §34).
 *
 * One Pi Durable store per generation under `.brain/context/`, one Brain
 * per project. At open, generations are reconciled: a head missing its
 * snapshot never existed as a frozen whole, so the Brain — authoritative —
 * builds the next generation with a fresh snapshot. The live store is
 * discovered, never pointed at by hand.
 *
 * State is one explicit value; behaviour is functions over it. The session
 * record carries the mutable present (the tree anchor, the pending list,
 * the last provider report); the Brain carries the durable past.
 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createRegistry,
  Harness,
  LiveDoc,
  type Conversation,
  type HarnessOptions,
  type ModelRef,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import { projectContext } from "../domain/projection.js";
import { createCartoExtension, CARTO_INSTRUCTIONS, type LiveSessionState } from "./carto-extension.js";
import type { BrainStore } from "./brain-store.js";
import {
  collapse,
  generationPaths,
  newGenerationId,
  reconcileGenerations,
  type CollapseOptions,
  type CollapseReport,
} from "./collapse.js";
import { writeSnapshot } from "./projection-files.js";

export interface LiveSessionOptions {
  /** Absolute project root. */
  root: string;
  /** The open Brain. The session reads and applies through it; the caller owns its lifecycle. */
  brain: BrainStore;
  /** pi-ai model access, e.g. createModels() with a provider set. */
  models: Models;
  model: ModelRef;
  now?: () => number;
  onReport?: HarnessOptions["onReport"];
}

export interface LiveSession {
  readonly root: string;
  readonly generation: string;
  readonly markdownPath: string;
  readonly contextWindow: number;
  readonly harness: Harness;
  readonly conversation: Conversation;
  /** The underlying database handle; closed by closeLiveSession. */
  readonly database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
  /** The mutable present; named fields, no hidden state (MINI.md §12). */
  readonly state: LiveSessionState;
  /** Set when a run ends with a requested collapse; the host performs it (see collapse request handling). */
  takeCollapseRequest(): string | null;
}

const FALLBACK_CONTEXT_WINDOW = 32_768;

export async function openLiveSession(options: LiveSessionOptions): Promise<LiveSession> {
  const root = resolve(options.root);
  const now = () => options.now?.() ?? Date.now();
  await mkdir(resolve(root, ".brain/context"), { recursive: true });

  // Generation: reuse the live one (crash recovery reopens identical bytes),
  // or build a new one from the Brain — which is authoritative.
  const reconciled = reconcileGenerations(root);
  let generation: string;
  if (reconciled.live !== null) {
    generation = reconciled.live.generation;
  } else {
    const stamp = new Date(now());
    generation = newGenerationId(stamp);
    const projection = projectContext(options.brain.read());
    writeSnapshot(root, generation, projection, stamp.getTime());
  }
  const paths = generationPaths(root, generation);

  const database = await openNodeSqliteDatabase(paths.store);
  await database.exec("PRAGMA secure_delete = ON");
  const storage = await SqliteStorage.open(database, { prefix: "live_" });

  const modelRef = options.model;
  const contextWindow = options.models.getModel(modelRef.provider, modelRef.modelId)?.contextWindow ?? FALLBACK_CONTEXT_WINDOW;
  const state: LiveSessionState = {
    contextWindow,
    pending: [],
    tree: { anchor: root, depth: 2 },
    collapseRequested: null,
    generation,
    lastReportedInput: undefined,
    toolWorkAtLastReport: 0,
    toolWorkAtLastRequest: 0,
  };

  let harness: Harness | undefined;
  try {
    const registry = createRegistry();
    registry.install(
      createCartoExtension({
        root,
        brain: options.brain,
        session: state,
        markdownPath: paths.markdown,
        now,
      }),
    );
    harness = await Harness.open(storage, {
      models: options.models,
      registry,
      now,
      // The environment the built-in bash runs through: one per conversation,
      // cwd at the project root. No policy of ours is attached to it.
      env: () => new NodeExecutionEnv({ cwd: root }),
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
    }, BACKGROUND_CONTEXT);
    const agent = {
      model: modelRef,
      instructions: CARTO_INSTRUCTIONS,
      // The context is gardened by collapse, never by Pi rewriting the transcript.
      compaction: { enabled: false },
      maxTurns: 16,
      cwd: root,
    };
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent });
    harness.resume();
    return {
      root,
      generation,
      markdownPath: paths.markdown,
      contextWindow,
      harness,
      conversation,
      database,
      state,
      takeCollapseRequest() {
        const reason = state.collapseRequested;
        state.collapseRequested = null;
        return reason;
      },
    };
  } catch (error) {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

/** Submit a person message; the submission settles when the run ends (including any continuations). */
export async function submitInput(session: LiveSession, text: string, whenBusy: "steer" | "followUp" = "followUp") {
  return session.conversation.submit({ type: "input", content: text, whenBusy }, BACKGROUND_CONTEXT);
}

/** Interrupt the current run at its Pi Durable boundary. No-op when idle. */
export async function interruptRun(session: LiveSession): Promise<void> {
  const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
  if (live?.run === undefined) return;
  await session.harness.abortTask(live.run.taskId, BACKGROUND_CONTEXT);
  await session.harness.waitForTask(live.run.taskId, BACKGROUND_CONTEXT);
}

/** The transcript without state-block markers — what a person-facing view may show. */
export async function sessionTranscript(session: LiveSession) {
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  return view.entries;
}

export async function closeLiveSession(session: LiveSession): Promise<void> {
  await session.harness.close(BACKGROUND_CONTEXT);
  await session.database.close().catch(() => undefined);
}

export interface CollapseOutcome {
  /** The fresh session on the new generation; the old session must not be used again. */
  readonly session: LiveSession;
  /** What collapse did: the new generation, the sealed archive, the purged one. */
  readonly report: CollapseReport;
  /** Why the collapse happened: the agent's reason, or the person's act. */
  readonly reason: string;
}

/**
 * Collapse the live session (MINI.md §5): interrupt the run at its boundary,
 * close the store, run the ceremony — freshness marks, new snapshot from the
 * Brain, seal the old store as the archive, export-then-delete the archive
 * whose grace expired, VACUUM — and reopen on the new generation. The
 * person's path passes any reason (or none); no boundary, no warning. The
 * caller shows the plain report afterwards.
 */
export async function collapseLiveSession(
  session: LiveSession,
  options: LiveSessionOptions,
  reason: string,
  ceremony: CollapseOptions = {},
): Promise<CollapseOutcome> {
  await interruptRun(session);
  await closeLiveSession(session);
  const report = await collapse(session.root, options.brain, ceremony);
  const next = await openLiveSession(options);
  return { session: next, report, reason };
}

