/**
 * The live session (§4, §5.7).
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

import type { ArchivedItem } from "../domain/archive.js";
import { projectContext } from "../domain/projection.js";
import { createCartoExtension, cartoInstructions, type LiveSessionState } from "./carto-extension.js";
import { personName } from "../domain/person.js";
import type { BrainStore } from "./brain-store.js";
import {
  collapse,
  generationPaths,
  newGenerationId,
  reconcileGenerations,
  rewriteHeadSnapshot,
  type CollapseOptions,
  type CollapseReport,
} from "./collapse.js";
import { writeSnapshot } from "./projection-files.js";
import { createStreamFreeze, type StreamFreeze } from "./stream-freeze.js";

export interface LiveSessionOptions {
  /**
   * How the harness arms its timers. Default `setTimeout`; a test passes fake
   * timers so a durable rest can be woken without waiting the real seconds out,
   * which is the only way to prove the wait lives in the store (§10).
   */
  setTimer?: (callback: () => void, delayMs: number) => () => void;
  /** Absolute project root. */
  root: string;
  /** The open Brain. The session reads and applies through it; the caller owns its lifecycle. */
  brain: BrainStore;
  /** pi-ai model access, e.g. createModels() with a provider set. */
  models: Models;
  model: ModelRef;
  /**
   * What the agent calls the person: the configured name, or the account that
   * launched Carto. Resolved once, here, so every string the model reads names
   * the same person and nothing guesses a second time.
   */
  person?: string;
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
  /** The mutable present; named fields, no hidden state (§5.3). */
  readonly state: LiveSessionState;
  /** The gate every model response body passes through: `^v` holds it (§9). */
  readonly freeze: StreamFreeze;
  /** Set when a run ends with a requested collapse; the host performs it (see collapse request handling). */
  takeCollapseRequest(): string | null;
}

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
    const projection = projectContext(await options.brain.read());
    writeSnapshot(root, generation, projection, stamp.getTime());
  }
  const paths = generationPaths(root, generation);

  const database = await openNodeSqliteDatabase(paths.store);
  await database.exec("PRAGMA secure_delete = ON");
  const storage = await SqliteStorage.open(database, { prefix: "live_" });

  const modelRef = options.model;
  // 0 = the window is unknown (silent server, no --context-window): pi
  // unclamps generation, and the UI renders "window unknown" until the
  // server advertises one (the driver re-discovers after every settled run).
  const contextWindow = options.models.getModel(modelRef.provider, modelRef.modelId)?.contextWindow ?? 0;
  const state: LiveSessionState = {
    person: options.person ?? personName(),
    contextWindow,
    paused: false,
    pending: [],
    tree: { anchor: root, depth: 2 },
    collapseRequested: null,
    readOnly: false,
    generation,
    lastReportedInput: undefined,
    toolWorkAtLastReport: 0,
    toolWorkAtLastRequest: 0,
  };

  // One gate per session, around every model call the session makes (§9).
  // Opened before the harness, so the first request it makes is already gated.
  const freeze = createStreamFreeze();
  const gatedModels = freeze.gate(options.models);

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
      models: gatedModels,
      registry,
      now,
      ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
      // The environment the built-in bash runs through: one per conversation,
      // cwd at the project root. No policy of ours is attached to it.
      env: () => new NodeExecutionEnv({ cwd: root }),
      // The person's delivery call (2026-11-20): queued messages land as ONE
      // batch at the next boundary, not one-at-a-time (pi's default). Read at
      // each use by pi, so this applies everywhere including follow-ups.
      settings: { steeringMode: "all", followUpMode: "all" },
      ...(options.onReport === undefined ? {} : { onReport: options.onReport }),
    }, BACKGROUND_CONTEXT);
    const agent = {
      model: modelRef,
      instructions: cartoInstructions(state.person),
      // The context is gardened by collapse, never by Pi rewriting the transcript.
      compaction: { enabled: false },
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
      freeze,
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

/**
 * Wait for the current chain of runs to end, without waiting for a sleeping
 * conversation-owned task. Submission.wait settles before Pi's after-run tasks
 * have queued their follow-ups; the live run remains present until they finish.
 */
export async function waitForRunEnd(session: LiveSession): Promise<void> {
  const watch = await session.harness.watchDoc(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
  if (watch === undefined) return;
  try {
    if (watch.value?.run === undefined) return;
    await new Promise<void>((resolve, reject) => {
      watch.start(async (call) => {
        if (call.kind === "failed") reject(call.error);
        else if (call.value.run === undefined) resolve();
      });
      void watch.closed.then((end) => {
        if (end.kind === "failed" || end.kind === "listener_error") reject(end.error);
        else resolve();
      });
    });
  } finally {
    await watch.stop();
  }
}

/** Submit a person message; the submission settles when its run answers. */
export async function submitInput(session: LiveSession, text: string, whenBusy: "steer" | "followUp" = "followUp") {
  // A message from the person ends a rest early (§10) and starts its own turn.
  // The rest is told, so when its time does come it starts nothing of its own:
  // one message, one turn.
  return session.conversation.submit({ type: "input", content: text, whenBusy }, BACKGROUND_CONTEXT);
}

/**
 * Apply a deletion now (§4.1): take the entry out of the model's view, and leave
 * everything else where it is.
 *
 * This is a rebuild, not a collapse. Nothing is swept, the generation does not
 * rotate, and no grace is spent; what changes is the prefill, which runs again
 * from the changed entry through the tail. The entry itself stays in the store —
 * "the text is gone from the model's view before it is gone from disk" (§4.1) —
 * and the head is untouched, so the frozen part of the projection is
 * byte-identical afterwards. A prune is an epilogue, not a head.
 */
export async function applyOmitNow(session: LiveSession, itemId: string): Promise<boolean> {
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  for (const [index, entry] of view.entries.entries()) {
    const messages = view.contributions[index] ?? [];
    const prefix = `${session.generation}:${entry.id}:`;
    const partKey = itemId.startsWith(prefix) ? itemId.slice(prefix.length) : undefined;
    if (String(entry.id) !== itemId && partKey === undefined) continue;
    if (messages.length === 0) return false;

    // Pi edits a whole entry. A row can instead be one part of an assistant
    // message, so replace that contribution with its other parts intact.
    let replacement = messages;
    if (partKey !== undefined && partKey !== "r") {
      let removed = false;
      replacement = messages.map((message) => {
        if (message.role !== "assistant") return message;
        let thinking = 0;
        let text = 0;
        const content = message.content.filter((part, partIndex) => {
          const key = part.type === "thinking" ? `t${thinking++}`
            : part.type === "text" ? `x${text++}`
              : part.type === "toolCall" ? `c${partIndex}` : "";
          if (key !== partKey) return true;
          removed = true;
          return false;
        });
        return { ...message, content };
      });
      if (!removed) return false;
      replacement = replacement.filter((message) => message.role !== "assistant" || message.content.length > 0);
    } else if (partKey === "r" && !messages.some((message) => message.role === "toolResult")) {
      return false;
    } else {
      replacement = [];
    }

    await session.conversation.submit(
      {
        type: "write",
        entry: {
          kind: "carto.apply-now",
          data: { entry: String(entry.id), item: itemId },
          edits: [replacement.length === 0
            ? { target: entry.id, action: "omit" }
            : { target: entry.id, action: "replace", messages: replacement }],
        },
      },
      BACKGROUND_CONTEXT,
    );
    return true;
  }
  return false;
}

/**
 * Apply a Brain record's archive or delete mark now (§4.1).
 *
 * The mark's own application, done at once: an archived record leaves the
 * Brain and enters the archive in one transaction, a deleted one leaves the
 * Brain and goes nowhere. Then the head is re-frozen for the generation that is
 * still open, because a Brain record is in the head and the model's view has to
 * change with the Brain — that rebuild is the whole cost of applying now, and
 * it is paid from the changed entry forward, never from the first byte.
 *
 * Nothing else moves. This is not a collapse: the store stays, the generation
 * stays, nothing is swept and no grace is spent.
 *
 * Returns whether a record was there to act on; false when it was already gone,
 * which is not an error — the person may have acted on it a moment ago.
 */
export async function applyRecordActionNow(
  session: LiveSession,
  brain: BrainStore,
  root: string,
  kind: "atlas" | "ledger" | "chat",
  id: string,
  action: "archive" | "delete",
): Promise<boolean> {
  const applied = await brain.applyRecordAction({ kind, id, action, generation: session.generation, now: Date.now() });
  if (!applied.found) return false;
  rewriteHeadSnapshot(root, session.generation, applied.brain, session.state.person, Date.now());
  return true;
}

/**
 * What a pause did, in the words the person is shown (§9).
 *
 * `held` and `interrupted` are both real pauses: the first caught a live
 * response body and is still holding it, the second caught the run between
 * requests, so nothing is being read and nothing new may start. An `interrupted`
 * pause did cost the work in flight — that is the price of pausing between
 * requests rather than mid-reply, and it is said plainly rather than hidden.
 */
export interface PauseOutcome {
  /** Whether the agent is paused now. */
  readonly paused: boolean;
  /** False when the request changed nothing: the agent was already in that state. */
  readonly changed: boolean;
  /** The run is held mid-reply, and this same reply continues when it lets go. */
  readonly held: boolean;
  /** The run was caught between requests, so its work in flight was interrupted. */
  readonly interrupted: boolean;
  /** An unpause let a held reply go on, rather than merely letting the agent run again. */
  readonly resumed: boolean;
  /** One line, plain, for the transcript and the headless driver. */
  readonly line: string;
}

/**
 * Pause or unpause the agent (§9).
 *
 * Pausing is not an interrupt. When a response body is in flight the gate holds
 * it and the same reply goes on later, token for token; nothing is committed or
 * discarded, and the agent is not told. When nothing is in flight there is no
 * stream to hold, so the pause lands on the round of tool calls: the run is
 * interrupted where it stands, and nothing starts of its own accord while the
 * pause lasts.
 *
 * Unpausing lets the held body go on. The agent rested while paused is a
 * durable task, so its own timer is what wakes it; nothing here starts work
 * the agent did not ask for.
 */
export async function togglePause(session: LiveSession, to?: boolean): Promise<PauseOutcome> {
  const paused = session.state.paused;
  const want = to ?? !paused;
  if (want === paused) {
    return {
      paused,
      changed: false,
      held: false,
      interrupted: false,
      resumed: false,
      line: paused ? "the agent is already paused" : "nothing is paused",
    };
  }
  session.state.paused = want;
  if (want) {
    if (session.freeze.freeze()) {
      return {
        paused: true,
        changed: true,
        held: true,
        interrupted: false,
        resumed: false,
        line: "paused: the agent is held in its stream, mid-sentence · ^v lets it continue · a line or command you send ends it",
      };
    }
    // Nothing to hold: the pause lands on the round of tool calls instead. The
    // run is read from the store, which is where a run exists — the same source
    // the interrupt uses — so the host keeps no second answer to "is it working".
    session.freeze.abandon();
    const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
    const interrupted = live?.run !== undefined;
    if (interrupted) await interruptRun(session);
    return {
      paused: true,
      changed: true,
      held: false,
      interrupted,
      resumed: false,
      line: interrupted
        ? "paused: the agent is interrupted where it stands · ^v lets it go on"
        : "paused: the agent starts nothing of its own · ^v lets it go on",
    };
  }
  const resumed = session.freeze.resume();
  return {
    paused: false,
    changed: true,
    held: false,
    interrupted: false,
    resumed,
    line: resumed ? "on again — the agent goes on with its stream" : "on again — the agent may work again",
  };
}

/** Interrupt the current run at its Pi Durable boundary. No-op when idle. */
export async function interruptRun(session: LiveSession): Promise<void> {
  const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
  if (live?.run === undefined) return;
  await session.harness.abortTask(live.run.taskId, BACKGROUND_CONTEXT);
  await session.harness.waitForTask(live.run.taskId, BACKGROUND_CONTEXT);
}

/** The transcript without state-block markers — what a person-facing view may show. */
/**
 * Put a restored ephemeral item back into the live context (§3.3).
 *
 * It goes back as the kind it was, as a passive entry in the conversation's own
 * store, which is where it came from — not in the Brain, which never held it.
 * Restoring does not pin it: the next collapse sweeps it again unless the person
 * pins it, and it goes back into the archive with its grace starting again.
 *
 * The entry carries no model messages, and that is deliberate rather than a
 * shortcut. The context pi builds drops a tool result whose call is not present
 * and reorders results under their calls, so a restored result submitted as a
 * message would either vanish or answer a call that never ran. What the person
 * gets back is the item itself, in the live context, under the kind it had; and
 * if they want it in the head they pin it, which is the one action that puts an
 * ephemeral item in front of the agent (§3.1).
 */
export async function restoreEphemeral(session: LiveSession, item: ArchivedItem): Promise<boolean> {
  const ephemeral = item.ephemeral;
  if (ephemeral === undefined) return false;
  const entity = ephemeral.data;
  const callId =
    entity !== null && typeof entity === "object" && typeof (entity as { callId?: unknown }).callId === "string"
      ? (entity as { callId: string }).callId
      : undefined;
  try {
    await session.conversation.submit(
      {
        type: "write",
        entry: {
          kind: "carto.restored",
          ...(callId === undefined ? {} : { data: { callId } }),
        },
      },
      BACKGROUND_CONTEXT,
    );
    return true;
  } catch {
    // A conversation that will not take the write — it is closing, or busy in a
    // way that refuses one — leaves the item in the archive rather than losing
    // it, and the person is told by the caller.
    return false;
  }
}

export async function sessionTranscript(session: LiveSession) {
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  // The raw entries remain on disk after an apply-now edit. Views must show
  // the contributions Pi actually sends, not the superseded raw messages.
  return view.entries.map((entry, index) => ({ ...entry, model: view.contributions[index] ?? [] }));
}

export async function closeLiveSession(session: LiveSession): Promise<void> {
  await session.harness.close(BACKGROUND_CONTEXT);
  await session.database.close().catch(() => undefined);
}

export interface CollapseOutcome {
  /** The fresh session on the new generation; the old session must not be used again. */
  readonly session: LiveSession;
  /** What collapse did: the new generation, the store it swept, and what the archive took and dropped. */
  readonly report: CollapseReport;
  /** Why the collapse happened: the agent's reason, or the person's act. */
  readonly reason: string;
}

/**
 * Collapse the live session (§4): interrupt the run at its boundary, close the
 * store, run the ceremony — freshness marks, new snapshot from the Brain, the
 * marks applied, the old store swept into the archive and deleted whole, the
 * archive's expired items dropped, VACUUM — and reopen on the new generation.
 * The person's path passes any reason (or none); no boundary, no warning. The
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
  // The Brain moves the marked records itself; what the new generation's frozen
  // prefill is built from is the Brain as it stands after that move (§3.3).
  // The head the next generation freezes names the same person every other
  // string names: one name, carried from the session that built it.
  const report = await collapse(session.root, options.brain, { person: session.state.person, ...ceremony });
  const next = await openLiveSession(options);
  // An ephemeral item a mark restored comes home to the live context, which is
  // the store the collapse just built (§3.3): it goes back as the kind it was,
  // with no pin, so the next collapse sweeps it again unless the person pins it.
  for (const item of report.restored) await restoreEphemeral(next, item);
  return { session: next, report, reason };
}

