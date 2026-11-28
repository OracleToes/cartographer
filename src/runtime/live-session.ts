import { personChatBindings, userText } from "../domain/chat-identity.js";
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
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createRegistry,
  Harness,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type Conversation,
  type EntryId,
  type HarnessOptions,
  type ModelRef,
  type Cursor,
  type TaskId,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { Message, Models } from "@earendil-works/pi-ai";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

import type { ArchivedItem } from "../domain/archive.js";
import { projectContext } from "../domain/projection.js";
import { createCartoExtension, generationProgressed, newGenerationWork, type LiveSessionState } from "./carto-extension.js";
import { personName } from "../domain/person.js";
import type { BrainStore, ContextEditJournal } from "./brain-store.js";
import type { ChatRecord, PinnedEphemeral } from "../domain/records.js";
import { parseEditedRecord } from "../domain/record-editor.js";
import {
  collapse,
  generationPaths,
  ephemeralItemId,
  newGenerationId,
  pinnedFileTexts,
  reconcileGenerations,
  readStoredDelegation,
  requireSingleConversationCollapse,
  removedPartKeys,
  editedPartValues,
  stablePartKeys,
  rewriteHeadSnapshot,
  type CollapseOptions,
  type CollapseReport,
} from "./collapse.js";
import { snapshotPaths, writeSnapshot } from "./projection-files.js";
import { DelegateInputCheckpointDoc } from "./delegate-inputs.js";
import { clearedInputCheckpoint, clearedInputReplay, DelegateInputReplayDoc } from "./delegate-input-replay.js";
import {
  appendCollapseLog,
  brainCountsOf,
  collectCollapseBodyEntries,
  type CollapseTrigger,
} from "./collapse-log.js";
import { createStreamFreeze, type StreamFreeze } from "./stream-freeze.js";
import { createInferenceAdmission } from "./inference-admission.js";
import { RestDoc } from "./sleep-task.js";
import { placeDelegationTransfer, prepareDelegationDestination } from "./delegate-return.js";
import { ensureDelegateRestoreDestination, requireDelegateRestoreDestination } from "./delegate-conversation.js";
import { createModelTelemetry } from "./model-telemetry.js";
import { COLLAPSE_WARNING_PERCENT, STATE_BLOCK_MARKER, splitContextMessages } from "../domain/state-block.js";
import { estimateContextTokens } from "../domain/estimate.js";
import { createJobTable, type JobTable } from "./jobs.js";
import { promptItemsOf } from "../ui/prompt-handles.js";
import { readProjectSettings, writeProjectSettings, type ProjectSettings } from "./workspace.js";
import { ensureBrainDirectory } from "./paths.js";

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
  /** Maximum entries in each state-block tree page. */
  treePageSize?: number;
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
  | { readonly kind: "collapse"; readonly reason: string; readonly trigger: "agent" | "automatic" }
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
  ensureBrainDirectory(root);
  const projectSettings = readProjectSettings(root);
  if (projectSettings.executionMode === "orchestration") {
    throw new Error("Orchestration mode is not yet available; this project cannot open in orchestration mode.");
  }

  // Generation: reuse the live one (crash recovery reopens identical bytes),
  // or build a new one from the Brain — which is authoritative.
  const pendingChatEdit = await options.brain.readPendingEdit();
  const reconciled = await reconcileGenerations(root, options.brain);
  if (pendingChatEdit !== undefined && reconciled.live?.generation !== pendingChatEdit.generation) {
    throw new Error("A pending context edit's generation is missing; all remaining data was preserved.");
  }
  let generation: string;
  if (reconciled.live !== null) {
    generation = reconciled.live.generation;
  } else {
    const stamp = new Date(now());
    generation = newGenerationId(stamp);
    const brain = await options.brain.read();
    const projection = projectContext(brain, pinnedFileTexts(root, brain), options.person ?? personName());
    writeSnapshot(root, generation, projection, stamp.getTime());
  }
  const paths = generationPaths(root, generation);
  const frozenText = await readFile(paths.markdown, "utf8");
  const headHandles = new Set([...frozenText.matchAll(/^X(\d+) \[(?:toolCall|reasoning|plainText|readResult|toolResult|personMessage)\]/gm)].map((match) => `X${match[1]}`));
  const headEphemeraCount = Math.max(0, ...[...headHandles].map((handle) => Number(handle.slice(1))));
  const openingBrain = await options.brain.read();
  const headEphemera = new Map(openingBrain.handles.entries.flatMap((entry) => {
    if (entry.kind !== "ephemera" || !headHandles.has(entry.handle)) return [];
    const item = openingBrain.ephemera.find((candidate) => candidate.id === entry.id);
    return item === undefined ? [] : [[entry.handle, item] as const];
  }));
  const sidecar = await readFile(paths.sidecar, "utf8").then((text) => JSON.parse(text) as { ephemeralItems?: Array<{ handle: string; item: import("../domain/records.js").PinnedEphemeral }> }).catch(() => ({ ephemeralItems: undefined }));
  for (const entry of sidecar.ephemeralItems ?? []) if (headHandles.has(entry.handle)) headEphemera.set(entry.handle, entry.item);

  const database = await openNodeSqliteDatabase(paths.store);
  await database.exec("PRAGMA secure_delete = ON");
  const storage = await SqliteStorage.open(database, { prefix: "live_" });

  const modelRef = options.model;
  // 0 = the window is unknown (silent server, no --context-window): pi
  // unclamps generation, and the UI renders "window unknown" until the
  // server advertises one (the driver re-discovers after every settled run).
  const contextWindow = options.models.getModel(modelRef.provider, modelRef.modelId)?.contextWindow ?? 0;
  const state: LiveSessionState = {
    activeModel: { ...modelRef },
    modelSupportsImages: () => options.models.getModel(state.activeModel.provider, state.activeModel.modelId)?.input.includes("image"),
    person: options.person ?? personName(),
    contextWindow,
    collapseWarningPercent: options.collapseWarningPercent ?? COLLAPSE_WARNING_PERCENT,
    paused: false,
    pending: [],
    tree: { anchor: root, depth: 2, ...(options.treePageSize === undefined ? {} : { limit: options.treePageSize }) },
    collapseRequested: null,
    collapseTrigger: null,
    readOnly: projectSettings.readOnly,
    pathScope: projectSettings.pathScope,
    generation,
    headEphemeraCount,
    headEphemera,
    lastReportedInput: undefined,
    desiredMaxOutput: options.models.getModel(modelRef.provider, modelRef.modelId)?.maxTokens ?? 0,
    work: newGenerationWork(),
    rebuiltAutomatically: false,
    toolWorkAtLastReport: 0,
    toolWorkAtLastRequest: 0,
    lastStateBlock: undefined,
  };

  // One gate per session, around every model call the session makes (§9).
  // Opened before the harness, so the first request it makes is already gated.
  const freeze = createStreamFreeze();
  const gatedModels = createInferenceAdmission(freeze.gate(options.models, createModelTelemetry(state), () => state.activeModel));
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
    // A committed transfer remains in the Brain until Pi has durably accepted
    // the same handoff and checkpoint; retry compares instead of duplicating.
    await placeDelegationTransfer(options.brain, harness, conversation, generation, BACKGROUND_CONTEXT);
    const pendingInputs = await harness.snapshot(DelegateInputCheckpointDoc, conversation.id, BACKGROUND_CONTEXT);
    const pendingReplay = await harness.snapshot(DelegateInputReplayDoc, conversation.id, BACKGROUND_CONTEXT);
    if (!clearedInputCheckpoint(pendingInputs) || !clearedInputReplay(pendingReplay)) {
      throw new Error("A delegate input checkpoint is awaiting replay; the session and inputs were preserved.");
    }
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
        state.collapseTrigger = null;
        return reason;
      },
      reviewCollapseRequest() {
        const reason = state.collapseRequested;
        const trigger = state.collapseTrigger;
        state.collapseRequested = null;
        state.collapseTrigger = null;
        if (reason === null) return { kind: "none" };
        // A generation that was itself rebuilt automatically and did nothing
        // before asking again is the loop this bound exists to break.
        if (state.rebuiltAutomatically && !generationProgressed(state.work, state.collapseWarningPercent)) {
          return { kind: "stop", reason, explanation: stalledCollapseExplanation(reason) };
        }
        const resolvedTrigger: "agent" | "automatic" = trigger ?? (reason === "the agent collapsed" ? "agent" : "automatic");
        return { kind: "collapse", reason, trigger: resolvedTrigger };
      },
    };
    state.loadPromptItems = async () => promptItemsOf(await sessionTranscript(session), generation);
    state.refreshHeadEphemera = async () => {
      // Apply-now may explicitly re-freeze the head. Adopt its identities at
      // the next request boundary, never halfway through the preceding call.
      const snapshot = await readFile(paths.sidecar, "utf8").then((text) => JSON.parse(text) as { ephemeralItems?: Array<{ handle: string; item: import("../domain/records.js").PinnedEphemeral }> }).catch(() => ({ ephemeralItems: undefined }));
      if (snapshot.ephemeralItems === undefined) return; // legacy or temporarily unreadable sidecar
      state.headEphemera = new Map(snapshot.ephemeralItems.map(({ handle, item }) => [handle, item]));
      state.headEphemeraCount = Math.max(0, ...snapshot.ephemeralItems.map(({ handle }) => Number(handle.slice(1)) || 0));
    };
    await recoverContextEdit(session);
    harness.resume();
    // Only restores already committed by a collapse are retried here. Ordinary
    // archive marks still wait for collapse. An active run can defer recovery;
    // its marked source remains safe and will be retried at the next collapse.
    const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
    if (live?.run === undefined) {
      for (const item of (await options.brain.readArchive()).items) {
        if (item.restorePending === true && item.mark?.action === "restore" && await restoreEphemeral(session, item)) {
          await options.brain.applyArchive({ kind: "restore-complete", id: item.id, expected: item });
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
  await recoverContextEdit(session);
  // The person has spoken: whatever the agent was caught in, this is a new
  // direction, so a collapse after it is not judged against the stall before it.
  session.state.rebuiltAutomatically = false;
  // Person Chat is the person's own message, recorded as it is sent (§2.3): it
  // is a Brain record, so it stays until someone deletes it and a collapse
  // carries it into the head instead of ending the conversation. The message
  // itself still goes in as the turn the agent answers. A message carried over
  // a collapse is admitted without passing here, so it is recorded once.
  const said = inputText(text);
  let recordId: string | undefined;
  if (said.trim().length > 0 && said.trim() !== STATE_BLOCK_MARKER) {
    recordId = `chat:person:${randomUUID()}`;
    const at = session.now();
    await session.brain.apply(
      { kind: "chat.record", record: { id: recordId, author: "user", text: said, createdAt: at, updatedAt: at } },
      at,
    );
  }
  return admitInput(session, text, whenBusy, recordId);
}

/** Admit an input without treating it as the person's new word; the one path every input takes. */
async function admitInput(session: LiveSession, text: UserInput, whenBusy: "steer" | "followUp", recordId?: string) {
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
    const id = await session.conversation.submit(tx, { type: "input", content: text, whenBusy, ...(recordId === undefined ? {} : { entry: { kind: "carto.user", data: { chatRecordId: recordId } } }) });
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

/** Snapshot the exact Pi contribution before handing it to an external editor. */
export interface LiveWorkEdit {
  itemId: string;
  generation: string;
  entryId: EntryId;
  partKey: string;
  kind: "reasoning" | "text" | "call" | "result" | "person";
  text: string;
  expected: string;
  pin?: PinnedEphemeral;
}

export async function readLiveWorkEdit(session: LiveSession, itemId: string): Promise<LiveWorkEdit> {
  const pin = (await session.brain.read()).ephemera.find((item) => item.id === itemId);
  const withPin = (snapshot: LiveWorkEdit, expectedKind: PinnedEphemeral["kind"], expectedText: string): LiveWorkEdit => {
    if (pin === undefined) return snapshot;
    if (pin.kind === "readResult" && pin.entity?.path !== undefined) throw new Error("The pinned read result is refreshed from its source file.");
    if (pin.kind !== expectedKind || pin.text !== expectedText) throw new Error("The pin and live item differ; edit or unpin the pin first.");
    return { ...snapshot, pin };
  };
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  const removed = removedPartKeys(view.entries, session.generation);
  const changed = editedPartValues(view.entries, session.generation);
  for (const [index, entry] of view.entries.entries()) {
    const prefix = `${session.generation}:${entry.id}:`;
    if (!itemId.startsWith(prefix)) continue;
    const key = itemId.slice(prefix.length);
    const messages = view.contributions[index] ?? [];
    const message = messages[0];
    const base = { itemId, generation: session.generation, entryId: entry.id, partKey: key, expected: JSON.stringify(messages) };
    if (messages.length !== 1 || message === undefined) break;
    if (key === "r" && message.role === "toolResult") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      return withPin({ ...base, kind: "result", text }, pin?.kind === "readResult" ? "readResult" : "toolResult", text);
    }
    if (key === "x0" && entry.kind === "carto.restored" && message.role === "user") {
      const text = userText(message.content);
      return withPin({ ...base, kind: "person", text }, "personMessage", text);
    }
    if (message.role !== "assistant") break;
    const original = entry.model?.find((candidate) => candidate.role === "assistant");
    if (original === undefined) break;
    const keys = stablePartKeys(original.content, message.content, removed.get(String(entry.id)) ?? new Set(), changed.get(String(entry.id)));
    const part = message.content[keys.indexOf(key)];
    if (part?.type === "thinking") {
      if (part.thinkingSignature || part.redacted) throw new Error("Signed or redacted reasoning cannot be safely edited.");
      return withPin({ ...base, kind: "reasoning", text: part.thinking }, "reasoning", part.thinking);
    }
    if (part?.type === "text") return withPin({ ...base, kind: "text", text: part.text }, "plainText", part.text);
    if (part?.type === "toolCall") {
      if (part.name === "chat") throw new Error("Chat calls are edited through their Chat record.");
      if (part.thoughtSignature) throw new Error("A signed tool call cannot be safely edited.");
      return withPin({ ...base, kind: "call", text: JSON.stringify(part.arguments, null, 2) + "\n" }, "toolCall", `${part.name} ${JSON.stringify(part.arguments)}`);
    }
    break;
  }
  throw new Error("The selected live item is no longer available for editing.");
}

/** Apply a context-only edit, preserving siblings and the original part identity. */
export async function editLiveWork(session: LiveSession, snapshot: LiveWorkEdit, text: string): Promise<void> {
  const previous = omitQueues.get(session) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await recoverContextEdit(session);
    if (session.generation !== snapshot.generation) throw new Error("The session collapsed while the editor was open.");
    if ((await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT))?.run !== undefined) throw new Error("The agent is running; stop it before editing live work.");
    const fresh = await readLiveWorkEdit(session, snapshot.itemId);
    if (fresh.expected !== snapshot.expected || fresh.kind !== snapshot.kind) throw new Error("The item changed while the editor was open.");
    if (JSON.stringify(fresh.pin ?? null) !== JSON.stringify(snapshot.pin ?? null)) throw new Error("The item's pin changed while the editor was open.");
    const current = await sessionTranscript(session);
    const item = current.find((entry) => entry.id === snapshot.entryId);
    if (JSON.stringify(item?.model) !== snapshot.expected) throw new Error("The item changed while the editor was open.");
    const tail = current.at(-1)?.id;
    const messages = JSON.parse(snapshot.expected) as Message[];
    const message = messages[0];
    let partJson: string | undefined;
    if (snapshot.kind === "result" && message?.role === "toolResult") {
      let inserted = false;
      message.content = message.content.flatMap<(typeof message.content)[number]>((part) => {
        if (part.type !== "text") return [part];
        if (inserted) return [];
        inserted = true;
        return [{ type: "text" as const, text }];
      });
      if (!inserted) message.content.unshift({ type: "text", text });
    } else if (snapshot.kind === "person" && message?.role === "user") {
      if (typeof message.content === "string") message.content = text;
      else {
        let inserted = false;
        message.content = message.content.flatMap<(typeof message.content)[number]>((part) => {
          if (part.type !== "text") return [part];
          if (inserted) return [];
          inserted = true;
          return [{ type: "text" as const, text }];
        });
        if (!inserted) message.content.unshift({ type: "text", text });
      }
    } else if (message?.role === "assistant") {
      const part = message.content[item?.partKeys?.indexOf(snapshot.partKey) ?? -1];
      if (snapshot.kind === "reasoning" && part?.type === "thinking") part.thinking = text;
      else if (snapshot.kind === "text" && part?.type === "text") part.text = text;
      else if (snapshot.kind === "call" && part?.type === "toolCall") {
        const args: unknown = JSON.parse(text);
        if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be a JSON object.");
        part.arguments = args as typeof part.arguments;
        delete part.argumentsError;
      } else throw new Error("The selected work item changed.");
      partJson = JSON.stringify(part);
    } else throw new Error("The selected work item changed.");
    const journal: ContextEditJournal = { kind: "work", operation: randomUUID(), generation: session.generation, entryId: snapshot.entryId, itemId: snapshot.itemId, before: snapshot.expected, messages, ...(partJson === undefined ? {} : { partJson }) };
    try {
      await session.conversation.commit(async (tx) => {
        if ((await tx.doc(LiveDoc, session.conversation.id)).run !== undefined || (await tx.doc(InboxDoc, session.conversation.id)).items.length !== 0) throw new Error("The agent is running or has queued input; wait before editing live work.");
        if (await tx.latestEntryId(session.conversation.id) !== tail) throw new Error("The context changed while the editor was open.");
        await session.brain.beginWorkEdit(journal, snapshot.pin, text);
        await session.conversation.submit(tx, contextEditSubmission(journal));
      }, BACKGROUND_CONTEXT);
      await session.brain.finishPendingEdit(journal.operation);
    } catch (error) {
      const pending = await session.brain.readPendingEdit();
      if (pending?.operation === journal.operation) {
        try { await recoverContextEdit(session); return; }
        catch { throw new Error("The work edit was saved but needs recovery; reopen Carto before continuing."); }
      }
      throw error;
    }
  });
  omitQueues.set(session, operation);
  try { await operation; } finally { if (omitQueues.get(session) === operation) omitQueues.delete(session); }
}

/** The Brain record and the exact live contribution it currently names. */
export interface LiveChatEdit {
  record: ChatRecord;
  generation: string;
  entryId: EntryId;
  itemId: string;
  partKey: string;
  before: string;
  tail: EntryId | undefined;
  pin?: PinnedEphemeral;
}

export async function readLiveChatEdit(session: LiveSession, record: ChatRecord): Promise<LiveChatEdit> {
  const brain = await session.brain.read();
  if (JSON.stringify(brain.chat.find((item) => item.id === record.id)) !== JSON.stringify(record)) throw new Error("The Chat record changed or disappeared.");
  const entries = await sessionTranscript(session);
  const head = await readFile(snapshotPaths(session.root, session.generation).sidecar, "utf8")
    .then((text) => (JSON.parse(text) as { chat?: string[] }).chat ?? []);
  if (head.includes(record.id)) throw new Error("This Chat record is in the frozen head.");
  const bindings = personChatBindings(entries, brain.chat, new Set(head));
  const candidates: Array<{ entryId: EntryId; key: string; messages: readonly Message[] }> = [];
  for (const entry of entries) {
    const message = entry.model[0];
    if (entry.model.length !== 1 || message === undefined) continue;
    if (record.author === "user" && message.role === "user" && bindings.get(entry.id) === record.id && userText(message.content) === record.text) {
      candidates.push({ entryId: entry.id, key: "x0", messages: entry.model });
    } else if (record.author === "agent" && message.role === "assistant" && record.id.startsWith("chat:")) {
      for (const [index, part] of message.content.entries()) {
        if (part.type !== "toolCall" || part.name !== "chat" || part.id !== record.id.slice(5)) continue;
        if (part.thoughtSignature) throw new Error("A signed Chat call cannot be safely edited.");
        if (part.arguments.text !== record.text) throw new Error("The Chat call and Brain record already differ.");
        const key = entry.partKeys?.[index];
        if (key !== undefined) candidates.push({ entryId: entry.id, key, messages: entry.model });
      }
    }
  }
  if (candidates.length !== 1) throw new Error("The live Chat contribution cannot be identified unambiguously.");
  const candidate = candidates[0]!;
  const itemId = ephemeralItemId(session.generation, candidate.entryId, candidate.key);
  const pin = brain.ephemera.find((item) => item.id === itemId);
  if (pin !== undefined) {
    const message = candidate.messages[0];
    const call = message?.role === "assistant" ? message.content.find((part) => part.type === "toolCall" && part.id === pin.entity?.callId) : undefined;
    const expectedPinText = record.author === "agent" && call?.type === "toolCall" ? `chat ${JSON.stringify(call.arguments)}` : record.text;
    if (pin.text !== expectedPinText) throw new Error("The pinned copy differs from the live Chat contribution; edit or unpin it first.");
  }
  return { record, generation: session.generation, entryId: candidate.entryId, itemId, partKey: candidate.key, before: JSON.stringify(candidate.messages), tail: entries.at(-1)?.id, ...(pin === undefined ? {} : { pin }) };
}

/** Resolve a selected live chat-tool call to its Brain record, not a duplicate pin. */
export async function chatRecordForLiveWork(session: LiveSession, itemId: string): Promise<ChatRecord | undefined> {
  for (const entry of await sessionTranscript(session)) {
    const prefix = `${session.generation}:${entry.id}:`;
    if (!itemId.startsWith(prefix)) continue;
    const message = entry.model[0];
    if (message?.role !== "assistant") return undefined;
    const part = message.content[entry.partKeys?.indexOf(itemId.slice(prefix.length)) ?? -1];
    if (part?.type !== "toolCall" || part.name !== "chat") return undefined;
    return (await session.brain.read()).chat.find((item) => item.id === `chat:${part.id}`);
  }
  return undefined;
}

/** Complete a journaled Pi replacement, or leave it intact if it cannot be proven safe. */
export async function recoverContextEdit(session: LiveSession): Promise<void> {
  const journal = await session.brain.readPendingEdit();
  if (journal === undefined) return;
  if (journal.generation !== session.generation) throw new Error("The pending context edit belongs to another generation.");
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  const kind = journal.kind === "work" ? "carto.edit-work" : "carto.edit-chat";
  const placed = view.entries.some((entry) => entry.kind === kind && entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data) && (entry.data as { operation?: unknown }).operation === journal.operation);
  if (!placed) {
    const index = view.entries.findIndex((entry) => entry.id === journal.entryId);
    if (index < 0 || JSON.stringify(view.contributions[index] ?? []) !== journal.before) throw new Error("Pending context edit conflicts with the live context; recovery stopped without discarding either copy.");
    const tail = view.entries.at(-1)?.id;
    await session.conversation.commit(async (tx) => {
      if ((await tx.doc(LiveDoc, session.conversation.id)).run !== undefined || (await tx.doc(InboxDoc, session.conversation.id)).items.length !== 0) throw new Error("A pending context edit needs an idle session to recover.");
      if (await tx.latestEntryId(session.conversation.id) !== tail) throw new Error("The context changed during edit recovery.");
      await session.conversation.submit(tx, contextEditSubmission(journal));
    }, BACKGROUND_CONTEXT);
  }
  await session.brain.finishPendingEdit(journal.operation);
}

function contextEditSubmission(journal: ContextEditJournal) {
  return {
    type: "write" as const,
    requestId: `carto.edit-${journal.kind === "work" ? "work" : "chat"}:${journal.operation}`,
    entry: {
      kind: journal.kind === "work" ? "carto.edit-work" : "carto.edit-chat",
      data: { operation: journal.operation, entry: String(journal.entryId), item: journal.itemId, ...(journal.recordId === undefined ? {} : { recordId: journal.recordId }), ...(journal.partJson === undefined ? {} : { partJson: journal.partJson }) },
      edits: [{ target: journal.entryId, action: "replace" as const, messages: journal.messages }],
    },
  };
}

export async function editLiveChat(session: LiveSession, snapshot: LiveChatEdit, text: string, now: number): Promise<void> {
  const previous = omitQueues.get(session) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    if (session.generation !== snapshot.generation) throw new Error("The session collapsed while the editor was open.");
    const edited = parseEditedRecord({ kind: "chat", value: snapshot.record }, text, now);
    if (edited.kind !== "chat") throw new Error("Invalid Chat edit.");
    const fresh = await readLiveChatEdit(session, snapshot.record);
    if (fresh.entryId !== snapshot.entryId || fresh.before !== snapshot.before) throw new Error("The Chat contribution changed while the editor was open.");
    if (JSON.stringify(fresh.pin ?? null) !== JSON.stringify(snapshot.pin ?? null)) throw new Error("The Chat pin changed while the editor was open.");
    const messages = JSON.parse(snapshot.before) as Message[];
    const message = messages[0];
    let partJson: string | undefined;
    if (snapshot.record.author === "user" && message?.role === "user") {
      if (typeof message.content === "string") message.content = edited.value.text;
      else {
        let inserted = false;
        message.content = message.content.flatMap<(typeof message.content)[number]>((part) => {
          if (part.type !== "text") return [part];
          if (inserted) return [];
          inserted = true;
          return [{ type: "text" as const, text: edited.value.text }];
        });
        if (!inserted) message.content.unshift({ type: "text", text: edited.value.text });
      }
    } else if (snapshot.record.author === "agent" && message?.role === "assistant") {
      const part = message.content.find((item) => item.type === "toolCall" && item.name === "chat" && item.id === snapshot.record.id.slice(5));
      if (part?.type !== "toolCall") throw new Error("The Chat call disappeared.");
      part.arguments = { ...part.arguments, text: edited.value.text };
      partJson = JSON.stringify(part);
    } else throw new Error("The Chat contribution changed.");
    const journal: ContextEditJournal = { operation: randomUUID(), generation: session.generation, entryId: snapshot.entryId, itemId: snapshot.itemId, recordId: snapshot.record.id, before: snapshot.before, messages, ...(partJson === undefined ? {} : { partJson }) };
    try {
      await session.conversation.commit(async (tx) => {
        if ((await tx.doc(LiveDoc, session.conversation.id)).run !== undefined || (await tx.doc(InboxDoc, session.conversation.id)).items.length !== 0) throw new Error("The agent is running or has queued input; wait before editing Chat.");
        if (await tx.latestEntryId(session.conversation.id) !== fresh.tail) throw new Error("The context changed while the editor was open.");
        await session.brain.beginChatEdit(journal, snapshot.record, text, now, snapshot.pin);
        await session.conversation.submit(tx, contextEditSubmission(journal));
      }, BACKGROUND_CONTEXT);
      await session.brain.finishPendingEdit(journal.operation);
    } catch (error) {
      const pending = await session.brain.readPendingEdit();
      if (pending?.operation === journal.operation) {
        try { await recoverContextEdit(session); return; }
        catch { throw new Error("The Chat edit was saved but needs recovery; reopen Carto before continuing."); }
      }
      throw error;
    }
  });
  omitQueues.set(session, operation);
  try { await operation; } finally { if (omitQueues.get(session) === operation) omitQueues.delete(session); }
}

async function omitOneNow(session: LiveSession, itemId: string): Promise<boolean> {
  await recoverContextEdit(session);
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  const removed = removedPartKeys(view.entries, session.generation);
  const changed = editedPartValues(view.entries, session.generation);
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
        const keys = stablePartKeys(original.content, message.content, removed.get(String(entry.id)) ?? new Set(), changed.get(String(entry.id)));
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
  if (kind === "chat") {
    const before = await brain.read();
    const record = before.chat.find((candidate) => candidate.id === id);
    if (record === undefined) return false;
    const entries = await sessionTranscript(session);
    if (record.author === "user") {
      const headIds = await readFile(snapshotPaths(root, session.generation).sidecar, "utf8")
        .then((text) => (JSON.parse(text) as { chat?: string[] }).chat ?? before.chat.map((record) => record.id))
        .catch(() => before.chat.map((record) => record.id));
      const bindings = personChatBindings(entries, before.chat, new Set(headIds));
      const entry = entries.find((candidate) => bindings.get(candidate.id) === id);
      if (entry !== undefined && !(await applyOmitNow(session, ephemeralItemId(session.generation, entry.id, "x0")))) return false;
    } else if (record.author === "agent" && id.startsWith("chat:")) {
      const callId = id.slice(5);
      for (const entry of entries) {
        const message = entry.model[0];
        if (message?.role !== "assistant") continue;
        const index = message.content.findIndex((part) => part.type === "toolCall" && part.id === callId && part.name === "chat");
        const key = entry.partKeys?.[index];
        if (index >= 0 && key !== undefined && !(await applyOmitNow(session, ephemeralItemId(session.generation, entry.id, key)))) return false;
      }
    }
  }
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
/** Persist first so a failed write never silently changes the active mode. */
export function setProjectModes(session: LiveSession, update: Partial<Pick<ProjectSettings, "readOnly" | "pathScope">>): ProjectSettings {
  if ("executionMode" in update) throw new Error("Orchestration mode is not yet available.");
  const settings = writeProjectSettings(session.root, update);
  session.state.readOnly = settings.readOnly;
  session.state.pathScope = settings.pathScope;
  return settings;
}

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
  await recoverContextEdit(session);
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
export async function interruptRun(session: LiveSession): Promise<boolean> {
  const live = await session.harness.snapshot(LiveDoc, session.conversation.id, BACKGROUND_CONTEXT);
  if (live?.run === undefined) return false;
  // abortTask joins the invocation. A frozen body can be waiting on our gate,
  // so initiate the abort and release that gate before waiting for the join.
  const abort = session.harness.abortTask(live.run.taskId, BACKGROUND_CONTEXT);
  if (session.freeze.frozen()) session.freeze.abandon();
  const result = await abort;
  await session.harness.waitForTask(live.run.taskId, BACKGROUND_CONTEXT);
  return result === "marked";
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
 * Legacy rows without enough metadata are refused rather than lost. Pi's
 * request-ID deduplication does not compare write contents, so retries check
 * the actual entries and Pi-derived contributions before reporting success.
 * The caller must keep context writers sealed through archive acknowledgement;
 * these checks detect changes but do not lock Pi or the Brain.
 */
export async function restoreEphemeral(session: Pick<LiveSession, "conversation">, item: ArchivedItem): Promise<boolean> {
  const ephemeral = item.ephemeral;
  if (ephemeral === undefined) return false;
  // Legacy rows have no source. New return-sweep rows must prove they came
  // from the main conversation; child contexts have no restore destination
  // yet. A malformed source cannot be treated as a legacy main item.
  const source: unknown = ephemeral.source;
  if (source !== undefined) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) return false;
    const value = source as { version?: unknown; generation?: unknown; conversationId?: unknown; entryId?: unknown; entryKind?: unknown };
    if (value.version !== 1 || typeof value.generation !== "string" || !value.generation ||
        value.conversationId !== ROOT_CONVERSATION_ID || typeof value.entryId !== "number" || !Number.isSafeInteger(value.entryId) || value.entryId < 1 ||
        typeof value.entryKind !== "string" || !value.entryKind || !item.id.startsWith(`${value.generation}:${value.entryId}:`)) return false;
  }
  return restoreEphemeralToConversation(session.conversation, item);
}

/** Shared Pi placement and retry verification; the caller validates routing. */
async function restoreEphemeralToConversation(conversation: Conversation, item: ArchivedItem, verify?: (tx: Tx) => Promise<void>): Promise<boolean> {
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
  const legacyUser = !Array.isArray(ephemeral.model) || ephemeral.model.length === 0;
  const matchesMessage = (actual: unknown, expected: Message): boolean => {
    // Legacy text-only archive rows did not retain their original timestamp.
    // A retry may reconstruct a different timestamp, but no other extra data.
    if (legacyUser && expected.role === "user") {
      if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
      const value = actual as Record<string, unknown>;
      return Object.keys(value).every((key) => ["role", "content", "timestamp"].includes(key)) &&
        value.role === "user" && typeof value.timestamp === "number" && isDeepStrictEqual(value.content, expected.content);
    }
    return isDeepStrictEqual(actual, expected);
  };
  const requestId = (index: number) => `carto.restore:${item.id}${model.length === 1 ? "" : `:${index}`}`;
  try {
    // Separate entries retain normal Context/sweep identity for the paired
    // call and result. Deterministic request ids make a partial retry safe.
    for (const [index, message] of model.entries()) {
      const submission = await conversation.submit(
        {
          type: "write",
          requestId: requestId(index),
          entry: { kind: "carto.restored", data: { archiveId: item.id }, model: [message] },
        },
        BACKGROUND_CONTEXT,
      );
      if ((await submission.wait(BACKGROUND_CONTEXT)).status !== "done") return false;
    }
    const inspect = async (tx: Tx) => {
      if (verify !== undefined) await verify(tx);
      const entries: EntryId[] = [];
      for (const [index, message] of model.entries()) {
        const submission = await tx.submissionByRequest(conversation.id, requestId(index));
        if (submission?.type !== "write" || submission.conversationId !== conversation.id || submission.status !== "done") {
          throw new Error("Restored submission conflicts with its archive item.");
        }
        const entry = await tx.entry(submission.entry);
        if (entry?.conversationId !== conversation.id || entry.kind !== "carto.restored" ||
            !isDeepStrictEqual(entry.data, { archiveId: item.id }) || entry.model?.length !== 1 || !matchesMessage(entry.model[0], message)) {
          throw new Error("Restored entry conflicts with its archive item.");
        }
        entries.push(entry.id);
      }
      return { entries, tail: await tx.latestEntryId(conversation.id), head: (await tx.latestHeadMarker(conversation.id))?.id };
    };
    const before = await conversation.commit(inspect, BACKGROUND_CONTEXT);
    const view = await conversation.context(BACKGROUND_CONTEXT, before.tail === undefined ? undefined : { at: before.tail });
    if (view.head?.id !== before.head || view.entries.length !== view.contributions.length) return false;
    for (const [index, entryId] of before.entries.entries()) {
      const positions = view.entries.flatMap((entry, position) => entry.id === entryId ? [position] : []);
      const messages = positions.length === 1 ? view.contributions[positions[0]!] : undefined;
      if (messages?.length !== 1 || !matchesMessage(messages[0], model[index]!)) return false;
    }
    const after = await conversation.commit(inspect, BACKGROUND_CONTEXT);
    return isDeepStrictEqual(before, after);
  } catch {
    // A conversation that will not take the write — it is closing, or busy in a
    // way that refuses one — leaves the item in the archive rather than losing
    // it, and the person is told by the caller.
    return false;
  }
}

/**
 * Dormant child-archive restoration. Each proven source conversation gets a
 * durable, ownerless passive destination; no child material enters main and
 * no delegate is resumed. The archive remains until Pi placement and the exact
 * pending archive snapshot are acknowledged. A retry reuses Pi's request IDs.
 * The host must seal main and child admissions, context and Brain/archive
 * writers across the entire operation; idle checks do not provide that lock.
 */
export async function restoreDelegateEphemeral(session: Pick<LiveSession, "brain" | "harness" | "conversation">, item: ArchivedItem): Promise<boolean> {
  const source: unknown = item.ephemeral?.source;
  if (item.layer !== "ephemeral" || item.record !== undefined || item.restorePending !== true || item.mark?.action !== "restore" ||
      !Array.isArray(item.ephemeral?.model) || item.ephemeral.model.length === 0 ||
      source === null || typeof source !== "object" || Array.isArray(source)) return false;
  const value = source as { version?: unknown; generation?: unknown; conversationId?: unknown; entryId?: unknown; entryKind?: unknown };
  if (value.version !== 1 || typeof value.generation !== "string" || !/^gen-[\w-]+$/.test(value.generation) ||
      typeof value.conversationId !== "number" || !Number.isSafeInteger(value.conversationId) || value.conversationId <= ROOT_CONVERSATION_ID ||
      typeof value.entryId !== "number" || !Number.isSafeInteger(value.entryId) || value.entryId < 1 ||
      typeof value.entryKind !== "string" || !value.entryKind || !item.id.startsWith(`${value.generation}:${value.entryId}:`)) return false;
  const origin = { generation: value.generation, conversationId: value.conversationId };
  try {
    const matches = (await session.brain.readArchive()).items.filter((candidate) => candidate.id === item.id);
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], item)) return false;
    const destination = await session.harness.commit((tx) => ensureDelegateRestoreDestination(tx, origin), BACKGROUND_CONTEXT);
    const conversation = await session.harness.conversation(destination, BACKGROUND_CONTEXT);
    if (conversation === undefined || !await restoreEphemeralToConversation(conversation, item, (tx) => requireDelegateRestoreDestination(tx, origin, destination))) return false;
    const result = await session.brain.applyArchive({ kind: "restore-complete", id: item.id, expected: item });
    return !result.refused && result.item !== undefined;
  } catch {
    return false;
  }
}

/**
 * Restore committed archive items before staging a delegation return. Callers
 * must seal all destination and archive writers; the per-item checks and
 * cross-store acknowledgements detect conflicts but are not locks. An invalid
 * or unsupported item blocks the return and remains in the archive.
 */
export async function restorePendingDelegationEphemera(
  session: Pick<LiveSession, "brain" | "harness" | "conversation">, items: readonly ArchivedItem[],
): Promise<void> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.layer !== "ephemeral" || item.record !== undefined || item.ephemeral === undefined ||
        item.restorePending !== true || item.mark?.action !== "restore" || ids.has(item.id)) {
      throw new Error("Invalid pending archive restore; the delegation return was preserved.");
    }
    ids.add(item.id);
    const matches = (await session.brain.readArchive()).items.filter((candidate) => candidate.id === item.id);
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], item)) throw new Error("A pending archive restore changed; the delegation return was preserved.");
    const source: unknown = item.ephemeral.source;
    const main = source === undefined || (source !== null && typeof source === "object" && !Array.isArray(source) &&
      (source as { conversationId?: unknown }).conversationId === ROOT_CONVERSATION_ID);
    if (main) {
      if (!await restoreEphemeral(session, item)) throw new Error("A main archive restore could not be placed; the delegation return was preserved.");
      const result = await session.brain.applyArchive({ kind: "restore-complete", id: item.id, expected: item });
      if (result.refused || result.item === undefined) throw new Error("A main archive restore changed before acknowledgement; the delegation return was preserved.");
    } else if (!await restoreDelegateEphemeral(session, item)) {
      throw new Error("A child archive restore could not be placed; the delegation return was preserved.");
    }
  }
}

/** Compose the dormant destination path; this does not install barriers or seal writers. */
export async function prepareDelegateSessionDestination(
  session: Pick<LiveSession, "brain" | "harness" | "conversation" | "generation">, id: string,
) {
  return prepareDelegationDestination(session.brain, session.harness, session.conversation, session.generation, id, BACKGROUND_CONTEXT,
    (items) => restorePendingDelegationEphemera(session, items));
}

export async function sessionTranscript(session: LiveSession) {
  const view = await session.conversation.context(BACKGROUND_CONTEXT);
  // The raw entries remain on disk after an apply-now edit. Views must show
  // the contributions Pi actually sends, not the superseded raw messages.
  const removed = removedPartKeys(view.entries, session.generation);
  const changed = editedPartValues(view.entries, session.generation);
  const chatIds = new Map<string, string>();
  for (const entry of view.entries) {
    if (entry.kind !== "carto.edit-chat" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
    const data = entry.data as { entry?: unknown; recordId?: unknown };
    if (typeof data.entry === "string" && typeof data.recordId === "string") chatIds.set(data.entry, data.recordId);
  }
  return view.entries.map((entry, index) => {
    const model = view.contributions[index] ?? [];
    const original = entry.model?.[0];
    const current = model[0];
    const partKeys = original?.role === "assistant" && current?.role === "assistant"
      ? stablePartKeys(original.content, current.content, removed.get(String(entry.id)) ?? new Set(), changed.get(String(entry.id)))
      : undefined;
    const chatId = current?.role === "user" ? chatIds.get(String(entry.id)) : undefined;
    const data = chatId === undefined ? entry.data : { ...(entry.data !== null && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : {}), chatRecordId: chatId };
    return { ...entry, data, model, partKeys };
  });
}

export async function closeLiveSession(session: LiveSession, requireCleanClose = false): Promise<void> {
  await session.harness.close(BACKGROUND_CONTEXT);
  if (requireCleanClose) await session.database.close();
  else await session.database.close().catch(() => undefined);
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
  /** Distinguish an agent `collapse` tool call from a forced automatic limit collapse. */
  readonly trigger?: "agent" | "automatic";
}

/** The text of a user input, for the places that need to show or compare it. */
const inputText = userText;

/**
 * The person's messages a collapse would otherwise lose: those still queued in
 * the old store, and those of a run that failed — pi settles them unanswered and
 * the sweep archives them, so the rebuilt agent would never see what it was asked.
 */
async function unansweredInputs(session: LiveSession): Promise<Array<{ content: UserInput; whenBusy: "steer" | "followUp"; recordId?: string }>> {
  const carried: Array<{ content: UserInput; whenBusy: "steer" | "followUp"; recordId?: string }> = [];
  const records = (await session.brain.read()).chat;
  const head = await readFile(snapshotPaths(session.root, session.generation).sidecar, "utf8")
    .then((text) => (JSON.parse(text) as { chat?: string[] }).chat ?? records.map((record) => record.id))
    .catch(() => records.map((record) => record.id));
  const bindings = personChatBindings(await sessionTranscript(session), records, new Set(head));
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
      const recordId = bindings.get(record.entry);
      carried.push({ content: message.content, whenBusy: "followUp", ...(recordId === undefined ? {} : { recordId }) });
    }
  }
  const inbox = await session.harness.snapshot(InboxDoc, session.conversation.id, BACKGROUND_CONTEXT);
  for (const item of inbox?.items ?? []) {
    if (item.mode === "write") continue;
    const data = item.entry?.data as { chatRecordId?: unknown } | undefined;
    const recordId = typeof data?.chatRecordId === "string" ? data.chatRecordId : undefined;
    carried.push({ content: item.content as unknown as UserInput, whenBusy: item.mode, ...(recordId === undefined ? {} : { recordId }) });
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
  // Refuse an unfinished handoff or unaccounted conversation before stopping
  // the live session. These preflight checks are not locks: collapse checks
  // them again after the session has stopped.
  const sourceStore = generationPaths(session.root, session.generation).store;
  await readStoredDelegation(sourceStore);
  await requireSingleConversationCollapse(sourceStore);
  await recoverContextEdit(session);
  const automatic = follow.automatic === true;
  const trigger: CollapseTrigger = !automatic
    ? "person"
    : (follow.trigger ?? (reason === "the agent collapsed" ? "agent" : "automatic"));
  // Read before anything is withdrawn: aborting settles queued inputs, and the
  // sweep removes the store that holds the rest.
  const carry = automatic ? await unansweredInputs(session) : [];
  const paused = session.state.paused;
  const preCollapseEntries = await sessionTranscript(session).catch(() => []);
  const brainBefore = brainCountsOf(await options.brain.read());
  const snapshotMeta = {
    fromGeneration: session.generation,
    model: `${options.model.provider}/${options.model.modelId}`,
    contextWindow: session.state.contextWindow,
    lastReportedInput: session.state.lastReportedInput ?? null,
    toolWorkAtLastReport: session.state.toolWorkAtLastReport,
    work: {
      requests: session.state.work.requests,
      steps: session.state.work.steps,
      startFill: session.state.work.startFill ?? null,
    },
    pendingWrites: session.state.pending.length,
    lastStateBlock: session.state.lastStateBlock ?? null,
    bodyEntries: collectCollapseBodyEntries(preCollapseEntries),
  };
  if (automatic) await session.conversation.abort(BACKGROUND_CONTEXT, { background: true });
  else await interruptRun(session);
  await closeLiveSession(session);
  // A forced automatic collapse (context overflow, declined compaction, or
  // recoverable length limit) happened without the agent calling `collapse`, so
  // record a System Chat message before freezing the new head: both the person
  // and the rebuilt agent see why the context reset.
  if (trigger === "automatic") {
    const at = options.now?.() ?? Date.now();
    const id = `chat:system-collapse:${snapshotMeta.fromGeneration}:${at}`;
    await options.brain.apply(
      {
        kind: "chat.record",
        record: {
          id,
          author: "system",
          text: `Automatic context collapse (${reason}). Rebuilt from the Brain.`,
          createdAt: at,
          updatedAt: at,
        },
      },
      at,
    );
  }
  // The Brain moves the marked records itself; what the new generation's frozen
  // prefill is built from is the Brain as it stands after that move (§3.3).
  // The head the next generation freezes names the same person every other
  // string names: one name, carried from the session that built it.
  const report = await collapse(session.root, options.brain, {
    person: session.state.person,
    carriedChatIds: carry.flatMap((input) => input.recordId === undefined ? [] : [input.recordId]),
    ...ceremony,
  });
  const brainAfter = brainCountsOf(await options.brain.read());
  const next = await openLiveSession({ ...options, jobs: options.jobs ?? session.jobs });
  let resumed = false;
  if (automatic) {
    next.state.rebuiltAutomatically = true;
    // A pause is the person's, and it outlives a collapse: nothing starts of its own.
    next.state.paused = paused;
    // The person's own words are never held back by a pause, which only stops
    // the agent starting on its own; a state block is that, so it waits.
    if (carry.length === 0 && !paused) await admitInput(next, STATE_BLOCK_MARKER, "followUp");
    for (const input of carry) await admitInput(next, input.content, input.whenBusy, input.recordId);
    resumed = carry.length > 0 || !paused;
  }
  const reportedTotal =
    snapshotMeta.lastReportedInput === null ? null : snapshotMeta.lastReportedInput + snapshotMeta.toolWorkAtLastReport;
  const fillPercent =
    reportedTotal !== null && snapshotMeta.contextWindow > 0
      ? Math.round((reportedTotal / snapshotMeta.contextWindow) * 100)
      : null;
  appendCollapseLog(session.root, {
    at: new Date(options.now?.() ?? Date.now()).toISOString(),
    fromGeneration: snapshotMeta.fromGeneration,
    toGeneration: report.generation,
    trigger,
    reason,
    model: snapshotMeta.model,
    contextWindow: snapshotMeta.contextWindow,
    lastReportedInput: snapshotMeta.lastReportedInput,
    toolWorkAtLastReport: snapshotMeta.toolWorkAtLastReport,
    fillPercent,
    work: snapshotMeta.work,
    pendingWrites: snapshotMeta.pendingWrites,
    brainBefore,
    brainAfter,
    swept: report.swept ?? null,
    archivedCount: report.archived.length,
    droppedCount: report.dropped.length,
    carried: automatic ? carry.length : 0,
    resumed,
    lastStateBlock: snapshotMeta.lastStateBlock,
    bodyEntries: snapshotMeta.bodyEntries,
  });
  // Opening retries committed ephemeral restores and acknowledges each one
  // only after placement. Do not submit the report's items a second time.
  return { session: next, report, reason, carried: automatic ? carry.length : 0, resumed };
}

export interface SwitchModelResult {
  readonly model: ModelRef;
  readonly changed: boolean;
  readonly contextWindow: number;
}

/**
 * Switch the live session's active model.
 *
 * Updating `AgentDoc` via `conversation.configure({ model })` leaves an
 * in-flight stream undisturbed and takes effect on the next request. A
 * per-session lookup also reconciles a prepared llama-swap checkpoint with the
 * selection when that next request starts, including after a restart.
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
  session.state.activeModel = { ...model };
  session.state.contextWindow = resolved.contextWindow;
  session.state.desiredMaxOutput = resolved.maxTokens;
  return {
    model,
    changed,
    contextWindow: resolved.contextWindow,
  };
}


