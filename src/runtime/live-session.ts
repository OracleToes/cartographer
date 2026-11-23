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
import { createHash, randomUUID } from "node:crypto";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createRegistry,
  Harness,
  InboxDoc,
  LiveDoc,
  type Conversation,
  type HarnessOptions,
  type ModelRef,
  type Cursor,
  type TaskId,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { Message, Models } from "@earendil-works/pi-ai";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import type { ArchivedItem } from "../domain/archive.js";
import { projectContext } from "../domain/projection.js";
import { createCartoExtension, generationProgressed, newGenerationWork, type LiveSessionState } from "./carto-extension.js";
import { personName } from "../domain/person.js";
import type { BrainStore } from "./brain-store.js";
import {
  collapse,
  generationPaths,
  newGenerationId,
  reconcileGenerations,
  removedPartKeys,
  stablePartKeys,
  rewriteHeadSnapshot,
  type CollapseOptions,
  type CollapseReport,
} from "./collapse.js";
import { writeSnapshot } from "./projection-files.js";
import { createStreamFreeze, type StreamFreeze } from "./stream-freeze.js";
import { RestDoc } from "./sleep-task.js";
import { createModelTelemetry } from "./model-telemetry.js";
import { COLLAPSE_WARNING_PERCENT, STATE_BLOCK_MARKER, splitContextMessages } from "../domain/state-block.js";
import { estimateContextTokens } from "../domain/estimate.js";
import { createJobTable, type JobTable } from "./jobs.js";

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
  /**
   * Context fill percentage (1–100) that triggers `[COLLAPSE NEEDED]` in the
   * state block. Default: 75 (COLLAPSE_WARNING_PERCENT).
   */
  collapseWarningPercent?: number;
  /** Persistent piped jobs owned by the host; preserved across context collapses. */
  jobs?: JobTable;
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
  /** The Brain this session reads and writes: where the person's words are recorded as they are sent (§2.3). */
  readonly brain: BrainStore;
  /** Persistent piped processes owned by the host; survives collapse. */
  readonly jobs: JobTable;
  /** The session's clock, so a record the host writes is stamped the way the tools stamp theirs. */
  readonly now: () => number;
  /** The mutable present; named fields, no hidden state (§5.3). */
  readonly state: LiveSessionState;
  /** The gate every model response body passes through: `^v` holds it (§9). */
  readonly freeze: StreamFreeze;
  /** Set when a run ends with a requested collapse; the host performs it (see collapse request handling). */
  takeCollapseRequest(): string | null;
  /**
   * Take the requested collapse and judge it: nothing was asked, or collapse
   * (the host passes the verdict to `collapseLiveSession`), or stop and explain
   * because collapsing again would only repeat the last one.
   */
  reviewCollapseRequest(): CollapseVerdict;
}

/** What a requested collapse comes to once the bound on automatic collapse has judged it. */
export type CollapseVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "collapse"; readonly reason: string }
  | { readonly kind: "stop"; readonly reason: string; readonly explanation: string };

/** The words a host shows when it declines to collapse a second time in a row. */
export function stalledCollapseExplanation(reason: string): string {
  return `Collapse stopped: the context was rebuilt from the Brain, then ended again (${reason}) before the agent got any work done, so another collapse would only repeat that. ` +
    "The Brain's head may be too large for the window, or the model cannot answer in what is left. " +
    "Mark records for archive or deletion, unpin what is not needed, or raise the context window, then send a message or collapse by hand.";
}

export async function openLiveSession(options: LiveSessionOptions): Promise<LiveSession> {
  const root = resolve(options.root);
  const now = () => options.now?.() ?? Date.now();
  await mkdir(resolve(root, ".brain/context"), { recursive: true });

  // Generation: reuse the live one (crash recovery reopens identical bytes),
  // or build a new one from the Brain — which is authoritative.
  const reconciled = await reconcileGenerations(root, options.brain);
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
    collapseWarningPercent: options.collapseWarningPercent ?? COLLAPSE_WARNING_PERCENT,
    paused: false,
    pending: [],
    tree: { anchor: root, depth: 2 },
    collapseRequested: null,
    readOnly: false,
    generation,
    lastReportedInput: undefined,
    desiredMaxOutput: options.models.getModel(modelRef.provider, modelRef.modelId)?.maxTokens ?? 0,
    work: newGenerationWork(),
    rebuiltAutomatically: false,
    toolWorkAtLastReport: 0,
    toolWorkAtLastRequest: 0,
  };

  // One gate per session, around every model call the session makes (§9).
  // Opened before the harness, so the first request it makes is already gated.
  const freeze = createStreamFreeze();
  const gatedModels = freeze.gate(options.models, createModelTelemetry(state));
  const jobs = options.jobs ?? createJobTable({ root, now });

  let harness: Harness | undefined;
  try {
    const registry = createRegistry();
    registry.install(
      createCartoExtension({
        root,
        brain: options.brain,
        session: state,
        jobs,
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
      // The context is gardened by collapse, never by Pi rewriting the transcript.
      compaction: { enabled: false },
      cwd: root,
    };
    const conversation = await harness.root(BACKGROUND_CONTEXT, { agent });
    // `harness.root` skips `configure` when reopening an existing generation
    // store, leaving the persisted `pi.agent` stuck on the previous model.
    // Reconcile the persisted model with the configured one immediately so a
    // `config.json` or `--model` change takes effect on restart without a
    // collapse.
    const persisted = (await conversation.agent(BACKGROUND_CONTEXT)).model;
    if (persisted?.provider !== modelRef.provider || persisted?.modelId !== modelRef.modelId) {
      await conversation.configure({ model: modelRef }, BACKGROUND_CONTEXT);
    }
    // The latest response is durable in Pi's context. Rehydrate its reported
    // usage on reopen instead of resetting the bar to an unrelated estimate.
    const prior = (await conversation.context(BACKGROUND_CONTEXT)).messages;
    const usageEstimate = estimateContextTokens(prior);
    if (usageEstimate.lastUsageIndex !== null) {
      const message = prior[usageEstimate.lastUsageIndex];
      if (message?.role === "assistant") {
        const usage = message.usage;
        const input = usage.input + usage.cacheRead + usage.cacheWrite;
        if (input > 0) {
          state.lastReportedInput = input;
          state.lastReportedOutput = usage.output;
          state.toolWorkAtLastReport = splitContextMessages(prior.slice(0, usageEstimate.lastUsageIndex + 1)).toolWorkTokens;
        }
      }
    }
    harness.resume();
    const session: LiveSession = {
      root,
      generation,
      markdownPath: paths.markdown,
      contextWindow,
      harness,
      conversation,
      database,
      brain: options.brain,
      jobs,
      now: options.now ?? Date.now,
      state,
      freeze,
      takeCollapseRequest() {
        const reason = state.collapseRequested;
        state.collapseRequested = null;
        return reason;
      },
      reviewCollapseRequest() {
        const reason = state.collapseRequested;
        state.collapseRequested = null;
        if (reason === null) return { kind: "none" };
        // A generation that was itself rebuilt automatically and did nothing
        // before asking again is the loop this bound exists to break.
        if (state.rebuiltAutomatically && !generationProgressed(state.work, state.collapseWarningPercent)) {
          return { kind: "stop", reason, explanation: stalledCollapseExplanation(reason) };
        }
        return { kind: "collapse", reason };
      },
    };
    // Only restores already committed by a collapse are retried here. Ordinary
    // archive marks still wait for collapse. An active run can defer recovery;
    // its marked source remains safe and will be retried at the next collapse.
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    if (live?.run === undefined) {
      for (const item of (await options.brain.readArchive()).items) {
        if (item.restorePending === true && item.mark?.action === "restore" && await restoreEphemeral(session, item)) {
          await options.brain.applyArchive({ kind: "restore-complete", id: item.id });
        }
      }
    }
    return session;
  } catch (error) {
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Wait for the current chain of runs (and any non-background after-run tasks
 * such as `TreeReadTask`) to settle, without waiting for a sleeping
 * background rest (`SleepTask`).
 */
export async function waitForRunEnd(session: LiveSession): Promise<void> {
  await session.conversation.waitForIdle(BACKGROUND_CONTEXT);
}

/** Submit a person message; the submission settles when its run answers. */
export async function submitInput(session: LiveSession, text: UserInput, whenBusy: "steer" | "followUp" = "followUp") {
  // The person has spoken: whatever the agent was caught in, this is a new
  // direction, so a collapse after it is not judged against the stall before it.
  session.state.rebuiltAutomatically = false;
  // Person Chat is the person's own message, recorded as it is sent (§2.3): it
  // is a Brain record, so it stays until someone deletes it and a collapse
  // carries it into the head instead of ending the conversation. The message
  // itself still goes in as the turn the agent answers. A message carried over
  // a collapse is admitted without passing here, so it is recorded once.
  const said = inputText(text);
  if (said.trim().length > 0 && said.trim() !== STATE_BLOCK_MARKER) {
    const at = session.now();
    await session.brain.apply(
      { kind: "chat.record", record: { id: `chat:person:${randomUUID()}`, author: "user", text: said, createdAt: at, updatedAt: at } },
      at,
    );
  }
  return admitInput(session, text, whenBusy);
}

/** Admit an input without treating it as the person's new word; the one path every input takes. */
async function admitInput(session: LiveSession, text: UserInput, whenBusy: "steer" | "followUp") {
  // Admit the message and invalidate the rest in one commit. Whichever of a
  // wake or this message reaches the session line first wins; a crash cannot
  // leave an admitted message alongside an eligible old wake.
  const { id, oldTasks } = await session.conversation.commit(async (tx) => {
    const rest = await tx.doc(RestDoc, session.conversation.id);
    const oldTasks: TaskId[] = [];
    if (rest.active !== null) oldTasks.push(rest.active as TaskId);
    if (rest.legacyAllowed) {
      // Upgrade existing sessions without losing or accidentally reviving
      // conversation-owned rests created by earlier versions.
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanTasks({ conversationId: session.conversation.id, kind: "carto.sleep" }, 100, cursor);
        for (const task of page.items) if (task.state.status !== "terminal") oldTasks.push(task.id);
        cursor = page.next;
      } while (cursor !== undefined);
    }
    const id = await session.conversation.submit(tx, { type: "input", content: text, whenBusy });
    rest.active = null;
    rest.legacyAllowed = false;
    return { id, oldTasks };
  }, BACKGROUND_CONTEXT);
  // Aborting frees the dormant task promptly. If interrupted here, the durable
  // invalidation above still prevents it from starting another run on restart.
  await Promise.all(oldTasks.map((id) => session.harness.abortTask(id, BACKGROUND_CONTEXT).catch(() => undefined)));
  const submission = await session.harness.submission(id, BACKGROUND_CONTEXT);
  if (submission === undefined) throw new Error("The admitted message is missing");
  return submission;
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
const omitQueues = new WeakMap<LiveSession, Promise<unknown>>();

export async function applyOmitNow(session: LiveSession, itemId: string): Promise<boolean> {
  // Pi queues context writes while a run is active. Serialize our edits and
  // wait for placement before reading the next contribution, otherwise two
  // quick actions replace the same old value and resurrect one another.
  const previous = omitQueues.get(session) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => omitOneNow(session, itemId));
  omitQueues.set(session, operation);
  try {
    return await operation;
  } finally {
    if (omitQueues.get(session) === operation) omitQueues.delete(session);
  }
}

async function omitOneNow(session: LiveSession, itemId: string): Promise<boolean> {
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  const removed = removedPartKeys(view.entries, session.generation);
  for (const [index, entry] of view.entries.entries()) {
    const messages = view.contributions[index] ?? [];
    const prefix = `${session.generation}:${entry.id}:`;
    const partKey = itemId.startsWith(prefix) ? itemId.slice(prefix.length) : undefined;
    if (String(entry.id) !== itemId && partKey === undefined) continue;
    if (messages.length === 0) return false;

    // Pi edits a whole entry. A row can instead be one part of an assistant
    // message, so replace that contribution with its other parts intact.
    let replacement = messages;
    if (partKey === "x0" && messages.length === 1 && messages[0]?.role === "user") {
      replacement = [];
    } else if (partKey !== undefined && partKey !== "r") {
      let foundPart = false;
      replacement = messages.map((message) => {
        if (message.role !== "assistant") return message;
        const original = entry.model?.find((candidate) => candidate.role === "assistant");
        if (original === undefined) throw new Error("Cannot identify the original assistant message");
        const keys = stablePartKeys(original.content, message.content, removed.get(String(entry.id)) ?? new Set());
        const content = message.content.filter((_part, partIndex) => {
          if (keys[partIndex] !== partKey) return true;
          foundPart = true;
          return false;
        });
        return { ...message, content };
      });
      if (!foundPart) return false;
      replacement = replacement.filter((message) => message.role !== "assistant" || message.content.length > 0);
    } else if (partKey === "r" && !messages.some((message) => message.role === "toolResult")) {
      return false;
    } else {
      replacement = [];
    }

    const submission = await session.conversation.submit(
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
    return (await submission.wait(BACKGROUND_CONTEXT)).status === "done";
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

export interface ResumeOutcome {
  /**
   * - `"running"`: a run is already active (not held) — strict non-action.
   * - `"unpaused"`: a held mid-stream reply was unpaused without sending a state block.
   * - `"started"`: admitted `STATE_BLOCK_MARKER` to start/resume the agent without a person message.
   */
  readonly kind: "running" | "unpaused" | "started";
  readonly submission?: Awaited<ReturnType<typeof admitInput>>;
  readonly line: string;
}

/**
 * Start or resume the agent without sending a person message.
 *
 * - If held mid-stream (`^v`), unpauses the held stream without admitting a
 *   state block (sending a block would break the stream).
 * - If already running (and not paused/held), returns `"running"` as a strict
 *   non-action.
 * - Otherwise (idle, sleeping, stopped, or paused while idle), clears pause
 *   and the automatic-collapse stall guard, cancels any dormant `SleepTask`,
 *   and admits `STATE_BLOCK_MARKER` so the agent starts from a fresh
 *   `<carto-state>` with no Chat record written to the Brain.
 */
export async function resumeSession(session: LiveSession): Promise<ResumeOutcome> {
  if (session.state.paused && session.freeze.frozen()) {
    const outcome = await togglePause(session, false);
    return { kind: "unpaused", line: outcome.line };
  }
  const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
  if (live?.run !== undefined) {
    return { kind: "running", line: "already running" };
  }
  const wasPaused = session.state.paused;
  session.state.paused = false;
  session.state.rebuiltAutomatically = false;
  const submission = await admitInput(session, STATE_BLOCK_MARKER, "followUp");
  return {
    kind: "started",
    submission,
    line: wasPaused ? "resumed — state block sent" : "started — state block sent",
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
 * New archive rows retain the original Pi messages. A result is accompanied by
 * its call because Pi drops orphan results; a fresh call id avoids collisions.
 * Legacy rows without enough metadata are refused rather than lost.
 */
export async function restoreEphemeral(session: LiveSession, item: ArchivedItem): Promise<boolean> {
  const ephemeral = item.ephemeral;
  if (ephemeral === undefined) return false;
  let model: Message[];
  if (Array.isArray(ephemeral.model) && ephemeral.model.length > 0) {
    const saved = structuredClone(ephemeral.model) as Message[];
    if (ephemeral.kind === "personMessage") {
      if (saved.length !== 1 || saved[0]?.role !== "user") return false;
    } else if (ephemeral.kind === "reasoning" || ephemeral.kind === "plainText" || ephemeral.kind === "toolCall") {
      if (saved.length !== 1 || saved[0]?.role !== "assistant" || saved[0].content.length !== 1) return false;
      const expected = ephemeral.kind === "reasoning" ? "thinking" : ephemeral.kind === "plainText" ? "text" : "toolCall";
      if (saved[0].content[0]?.type !== expected) return false;
    } else {
      if (saved.length !== 2 || saved[0]?.role !== "assistant" || saved[1]?.role !== "toolResult") return false;
      if (saved[0].content.length !== 1 || saved[0].content[0]?.type !== "toolCall" || saved[0].content[0].id !== saved[1].toolCallId) return false;
    }
    const assistant = saved[0];
    if (assistant?.role === "assistant") {
      // Incomplete metadata in legacy or damaged rows is not safe to send.
      if (!assistant.api || !assistant.provider || !assistant.model || !assistant.usage || typeof assistant.timestamp !== "number") return false;
      const part = assistant.content[0];
      if (part?.type === "toolCall") {
        const id = `call_carto_${createHash("sha256").update(item.id).digest("hex").slice(0, 24)}`;
        part.id = id;
        const result = saved[1];
        if (result?.role === "toolResult") result.toolCallId = id;
      }
    }
    model = saved;
  } else if (ephemeral.kind === "personMessage") {
    model = [{ role: "user", content: ephemeral.text, timestamp: Date.now() }];
  } else {
    return false;
  }
  try {
    // Separate entries retain normal Context/sweep identity for the paired
    // call and result. Deterministic request ids make a partial retry safe.
    for (const [index, message] of model.entries()) {
      const submission = await session.conversation.submit(
        {
          type: "write",
          requestId: `carto.restore:${item.id}${model.length === 1 ? "" : `:${index}`}`,
          entry: { kind: "carto.restored", data: { archiveId: item.id }, model: [message] },
        },
        BACKGROUND_CONTEXT,
      );
      if ((await submission.wait(BACKGROUND_CONTEXT)).status !== "done") return false;
    }
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
  const removed = removedPartKeys(view.entries, session.generation);
  return view.entries.map((entry, index) => {
    const model = view.contributions[index] ?? [];
    const original = entry.model?.[0];
    const current = model[0];
    const partKeys = original?.role === "assistant" && current?.role === "assistant"
      ? stablePartKeys(original.content, current.content, removed.get(String(entry.id)) ?? new Set())
      : undefined;
    return { ...entry, model, partKeys };
  });
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
  /** Person messages carried into the new generation instead of being lost with the old store. */
  readonly carried: number;
  /** The new generation was started on its own: the carried messages, or a state block. */
  readonly resumed: boolean;
}

/** How a collapse the agent or the model's limits asked for carries on afterwards. */
export interface CollapseFollow {
  /**
   * The collapse was not the person's act: the person's messages that never
   * got an answer go with it into the new generation, and the new generation
   * starts on its own, so nobody has to un-stick the agent.
   */
  readonly automatic?: boolean;
}

/** The text of a user input, for the places that need to show or compare it. */
const inputText = (content: UserInput): string =>
  typeof content === "string"
    ? content
    : content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("");

/**
 * The person's messages a collapse would otherwise lose: those still queued in
 * the old store, and those of a run that failed — pi settles them unanswered and
 * the sweep archives them, so the rebuilt agent would never see what it was asked.
 */
async function unansweredInputs(session: LiveSession): Promise<Array<{ content: UserInput; whenBusy: "steer" | "followUp" }>> {
  const carried: Array<{ content: UserInput; whenBusy: "steer" | "followUp" }> = [];
  const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
  const failure = live?.runFailure;
  if (failure !== undefined && failure.reason === "model_error") {
    const view = await session.conversation.context(BACKGROUND_CONTEXT);
    for (const id of failure.inputs) {
      const submission = await session.harness.submission(id, BACKGROUND_CONTEXT);
      const record = submission === undefined ? undefined : await submission.status(BACKGROUND_CONTEXT);
      if (record === undefined || record.type !== "input" || record.entry === undefined) continue;
      const message = view.entries.find((entry) => entry.id === record.entry)?.model?.[0];
      if (message?.role !== "user" || inputText(message.content).trim() === STATE_BLOCK_MARKER) continue;
      carried.push({ content: message.content, whenBusy: "followUp" });
    }
  }
  const inbox = await session.harness.snapshot(InboxDoc, session.conversation.id, BACKGROUND_CONTEXT);
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    carried.push({ content: item.content as unknown as UserInput, whenBusy: item.mode });
  }
  return carried;
}

/**
 * Collapse the live session (§4): interrupt the run at its boundary, close the
 * store, run the ceremony — freshness marks, new snapshot from the Brain, the
 * marks applied, the old store swept into the archive and deleted whole, the
 * archive's expired items dropped, VACUUM — and reopen on the new generation.
 * The person's path passes any reason (or none); no boundary, no warning. The
 * caller shows the plain report afterwards.
 *
 * An automatic collapse (the agent's, or one the model's limits forced) goes on
 * by itself: the person's unanswered messages are carried into the new
 * generation, and it starts on a state block when there are none. What the
 * agent had not written to the Brain is gone, as the person agreed.
 */
export async function collapseLiveSession(
  session: LiveSession,
  options: LiveSessionOptions,
  reason: string,
  ceremony: CollapseOptions = {},
  follow: CollapseFollow = {},
): Promise<CollapseOutcome> {
  const automatic = follow.automatic === true;
  // Read before anything is withdrawn: aborting settles queued inputs, and the
  // sweep removes the store that holds the rest.
  const carry = automatic ? await unansweredInputs(session) : [];
  const paused = session.state.paused;
  if (automatic) await session.conversation.abort(BACKGROUND_CONTEXT, { background: true });
  else await interruptRun(session);
  await closeLiveSession(session);
  // The Brain moves the marked records itself; what the new generation's frozen
  // prefill is built from is the Brain as it stands after that move (§3.3).
  // The head the next generation freezes names the same person every other
  // string names: one name, carried from the session that built it.
  const report = await collapse(session.root, options.brain, {
    person: session.state.person,
    carriedTexts: carry.map((input) => inputText(input.content)),
    ...ceremony,
  });
  const next = await openLiveSession({ ...options, jobs: options.jobs ?? session.jobs });
  // Opening retries committed ephemeral restores and acknowledges each one
  // only after placement. Do not submit the report's items a second time.
  if (!automatic) return { session: next, report, reason, carried: 0, resumed: false };
  next.state.rebuiltAutomatically = true;
  // A pause is the person's, and it outlives a collapse: nothing starts of its own.
  next.state.paused = paused;
  // The person's own words are never held back by a pause, which only stops
  // the agent starting on its own; a state block is that, so it waits.
  if (carry.length === 0 && !paused) await admitInput(next, STATE_BLOCK_MARKER, "followUp");
  for (const input of carry) await admitInput(next, input.content, input.whenBusy);
  return { session: next, report, reason, carried: carry.length, resumed: carry.length > 0 || !paused };
}

export interface SwitchModelResult {
  readonly model: ModelRef;
  readonly changed: boolean;
  readonly contextWindow: number;
}

/**
 * Switch the live session's active model.
 *
 * Pi resolves `agent.model` in `generation`'s `prepare` phase at the start of
 * each LLM request and fixes it for that request, so updating `AgentDoc` via
 * `conversation.configure({ model })` leaves any in-flight request undisturbed
 * and takes effect at the next natural boundary (the next step or next turn).
 */
export async function switchSessionModel(
  session: LiveSession,
  models: Models,
  model: ModelRef,
): Promise<SwitchModelResult> {
  const resolved = models.getModel(model.provider, model.modelId);
  if (resolved === undefined) {
    throw new Error(`Model "${model.provider}/${model.modelId}" is not in the provider catalog.`);
  }
  const current = (await session.conversation.agent(BACKGROUND_CONTEXT)).model;
  const changed = current?.provider !== model.provider || current?.modelId !== model.modelId;
  if (changed) {
    await session.conversation.configure({ model }, BACKGROUND_CONTEXT);
  }
  session.state.contextWindow = resolved.contextWindow;
  session.state.desiredMaxOutput = resolved.maxTokens;
  return {
    model,
    changed,
    contextWindow: resolved.contextWindow,
  };
}


