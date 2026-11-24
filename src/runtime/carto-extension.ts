/**
 * The Carto extension: the frozen projection as a byte-stable section, the
 * product tools, and the hooks that carry the state block (§5.3, §5.7).
 *
 * The block is appended to every request as a trailing user-role message and
 * never persisted: `beforeRequest` strips the markers the transcript
 * legitimately holds and appends a fresh block; `onYield` continues a
 * tool-free answer with a byte-sized marker, which is how a turn that ends
 * silently still starts the next one. The model sees exactly one current block
 * at the tail; the store keeps only markers; markers die with the generation's
 * store at collapse. Blocks never accumulate.
 */
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";

import { CompactionTask, GenerationTask, defineExtension, defineTool, hook, runEndTask, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import type { Message } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { isContextOverflow, isRecoverableLength } from "@earendil-works/pi-ai/utils/overflow";

import { handleOf } from "../domain/handles.js";
import type { CartoBrain } from "../domain/records.js";
import {
  COLLAPSE_WARNING_PERCENT,
  STATE_BLOCK_MARKER,
  appendStateBlock,
  contextFillPercent,
  estimateSerialized,
  renderStateBlock,
  splitContextMessages,
  stripStateBlocks,
  type MarkLine,
  type StateBlockInput,
} from "../domain/state-block.js";
import { projectTreeBlock } from "./project-tree.js";
import { lexicalProjectPath } from "./workspace.js";
import { SleepTask } from "./sleep-task.js";
import { TreeReadTask } from "./tree-read-task.js";
import { createTools, type ToolSession } from "./tools.js";
import type { BrainStore } from "./brain-store.js";
import type { ModelTelemetry } from "./model-telemetry.js";
import { summarizeJobs, type JobTable } from "./jobs.js";
import { promptHandles } from "../ui/prompt-handles.js";

/**
 * The system prompt (§7): the tools describe themselves, so this carries only
 * what no single description can say — how to read the environment, how to
 * think about a context that is maintained rather than accumulated, what to do
 * with a turn, and the things nothing can enforce.
 */
export function cartoInstructions(person: string): string {
  return [
    `You are Carto: the working attention on one project, kept for ${person}. Your plain text is your own thinking; ${person} hears you through \`chat\`, so say what matters there plainly, once.`,
    `Every visible item carries a handle: H is this prompt, Y tools, A/L/C Brain records, U is ${person}'s messages, X your working, B the \`<carto-state>\` block, T1 the tree (F files, D directories), J persistent jobs, R/S tool and shell results, and P pins. Each request ends with \`<carto-state>\` showing mode, fullness, recent writes, staleness, jobs, tree, pins, and marks.`,
    `Think before you move. When given a task, map the problem and its steps into a loose graph in Atlas: goals linked to steps down to atomic leaves attached to the files they touch, working leaves before stems with no rigid order beyond that. Keep Ledger light and live: your active leaf, open questions, what is solved, and current progress.`,
    `Build in small, atomic steps: one function, one line, one value change, or one focused chunk at a time. When adding a file, \`create\` minimal boilerplate or a skeleton first, then grow it incrementally with \`edit\` so each step is easy to read, run, and judge. Update your existing Atlas or Ledger handle in place as you go, for nearly every change, so a collapse at any moment (even mid-step) leaves your progress, solved pieces, and next move intact.`,
    `Experience and verify what you build before handing it over. Build and maintain one reusable, non-accumulative, low-token interactive testing harness shaped for the project, like your own dev dashboard: extend it in place as the project grows rather than piling up one-off test files or growing scripted sequences. Use it to drive the real product as someone using it and as a developer, manipulate live state directly, jump into tricky states and edge cases, and inspect compact state output after each action so bugs surface to you instead of ${person}. Treat \`sleep\` as a last resort: keep exercising the product, probing edge cases, and fixing what breaks until you can genuinely find nothing else left to verify or improve, and \`sleep\` only when work is exhausted.`,
    `Maintain your own context proactively. Nothing outside the Brain and pinned items survives a collapse, and you see external changes only when you read a file or see a stale notice. Pin the files you are actively editing, \`mark\` finished task-leaves for archive or delete (or fold lasting understanding into Atlas notes), and \`collapse\` naturally at boundaries (after planning, after finishing a leaf, or before starting new work) so every step runs in a clean context built for the problem in front of you.`,
    `In read only mode, explore and answer without modifying files. \`.brain\` is Carto's own storage and stays untouched.`,
  ].join("\n\n");
}

export interface LiveSessionState extends ToolSession, ModelTelemetry {
  /** The person's current model selection, including across recovered requests. */
  activeModel: ModelRef;
  /** What the agent calls the person: the configured name, or the launching account. */
  person: string;
  /** The active context window; the driver adjusts it when llama-swap advertises capacity. */
  contextWindow: number;
  /** Fill percentage (1–100) that triggers `[COLLAPSE NEEDED]` in the state block. */
  collapseWarningPercent: number;
  /**
   * The person has paused the agent (§9). Pausing is not an interrupt and is
   * never told to the agent, so nothing in the block mentions it; the flag is
   * here because the UI and the driver read the one state, and here is where
   * this session's state lives.
   */
  paused: boolean;
  lastReportedInput: number | undefined;
  lastReportedOutput?: number | undefined;
  /**
   * The most one response was meant to write: pi's `maxTokens` for the model,
   * before any clamping to the context. 0 when it is not known. A `length`
   * stop below it may be the context talking; one at it is an ordinary limit.
   */
  desiredMaxOutput: number;
  /** What this generation has done; the bound on automatic collapse is judged on it. */
  work: GenerationWork;
  /**
   * This generation was itself born of an automatic collapse. If it ends in
   * another collapse request having done no work, collapsing again would only
   * repeat itself, so the host stops and says so instead.
   */
  rebuiltAutomatically: boolean;
  /** Tool-work estimate as of the last provider report. */
  toolWorkAtLastReport: number;
  /** Tool-work estimate as of the last request; folds into the report at afterResponse. */
  toolWorkAtLastRequest: number;
  /** The most recent `<carto-state>` block appended on the wire (RAM-only, for diagnostic dumps). */
  lastStateBlock?: string | undefined;
}

/** What one generation has done, counted from the hooks, for the bound on automatic collapse. */
export interface GenerationWork {
  /** Requests sent. */
  requests: number;
  /** Fill of the first request, in percent; undefined while the window is unknown. */
  startFill: number | undefined;
  /** Responses that were steps of work: a stop or tool use that was not just the collapse call. */
  steps: number;
}

export const newGenerationWork = (): GenerationWork => ({ requests: 0, startFill: undefined, steps: 0 });

/** Whether a generation that asks to collapse again has done anything the last collapse made room for. */
export function generationProgressed(work: GenerationWork, warningPercent: number = COLLAPSE_WARNING_PERCENT): boolean {
  if (work.steps === 0) return false;
  return !(work.startFill !== undefined && work.startFill >= warningPercent);
}

export interface CartoExtensionOptions {
  root: string;
  brain: BrainStore;
  session: LiveSessionState;
  /** Persistent piped jobs owned by the host (survives collapse). */
  jobs?: JobTable;
  /** Absolute path of the frozen projection for this generation. */
  markdownPath: string;
  now?: () => number;
}

const estimatePart = estimateSerialized;

/** Lexical resolve; returns null instead of throwing (a path outside the root is a stale reference, not a crash). */
function lexicalProjectPathSafe(root: string, path: string): string | null {
  try {
    return lexicalProjectPath(root, path);
  } catch {
    return null;
  }
}

/** The file's mtime in ms, or null when it cannot be stat'd. */
function statMtimeSafe(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Atlas nodes whose file attachment has drifted: the file is missing, or newer
 * than the note written about it. Checked live against the filesystem, not
 * against a stored marker. The state block and the views ask this; the collapse
 * persists the same truth onto the entries.
 */
export function liveStaleMarks(brain: CartoBrain, root: string): Array<{ kind: "atlas"; label: string }> {
  const marks: Array<{ kind: "atlas"; label: string }> = [];
  for (const node of brain.atlas) {
    const drifted = node.attachments.some((attachment) => {
      if (attachment.kind !== "file") return false;
      const real = lexicalProjectPathSafe(root, attachment.path);
      if (real === null) return true;
      const stat = statMtimeSafe(real);
      return stat === null || stat > node.updatedAt;
    });
    if (!drifted) continue;
    const handle = handleOf(brain.handles, "atlas", node.id);
    if (handle !== undefined) marks.push({ kind: "atlas", label: handle });
  }
  return marks.sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Everything the block lists as stale, each with the reason it is: the one place
 * the three kinds of drift are gathered (§5.5).
 */
function staleMarksFor(
  brain: CartoBrain,
  root: string,
  session: CartoExtensionOptions["session"],
  markdownPath: string,
): { items: Array<{ handle: string; why: string }>; modifiedPins: string[] } {
  const items: Array<{ handle: string; why: string }> = [];
  for (const mark of liveStaleMarks(brain, root)) {
    items.push({ handle: mark.label, why: "the file changed after this note" });
  }
  const pinDrift = staleFileHandles(brain, root, session, markdownPath);
  const modifiedPins: string[] = [];
  for (const drift of pinDrift) {
    items.push({ handle: drift.handle, why: drift.why });
    if (drift.modified) modifiedPins.push(drift.handle);
  }
  for (const id of staleReadResultHandles(brain, root)) {
    const handle = [...(session.headEphemera ?? new Map()), ...(session.liveEphemera ?? new Map())].find(([, item]) => item.id === id)?.[0]
      ?? handleOf(brain.handles, "ephemera", id);
    if (handle !== undefined) items.push({ handle, why: "a pinned reading, and the file has changed since" });
  }
  return { items, modifiedPins };
}

/**
 * Handles of pinned files that are gone or changed on disk since the head was
 * frozen. A pin is a promise the head holds the current file, so drift says so
 * (§5.1, §5.5).
 */
function staleFileHandles(
  brain: CartoBrain,
  root: string,
  session: CartoExtensionOptions["session"],
  markdownPath: string,
): Array<{ handle: string; why: string; modified: boolean }> {
  if (brain.files.length === 0) return [];
  const tree = projectTreeBlock(root, session.tree.anchor, session.tree.depth, brain);
  const snapshotMtime = statMtimeSafe(markdownPath);
  const drifted: Array<{ handle: string; why: string; modified: boolean }> = [];
  for (const file of brain.files) {
    const real = lexicalProjectPathSafe(root, file.path);
    const mtime = real === null ? null : statMtimeSafe(real);
    let handle: string | undefined;
    for (const [path, named] of tree.handles) if (path === file.path) handle = named;
    const label = handle ?? file.path;
    if (mtime === null) {
      drifted.push({ handle: label, why: "pinned, and the file is gone", modified: false });
    } else if (snapshotMtime !== null && mtime > snapshotMtime + 50) {
      drifted.push({ handle: label, why: "pinned copy in head is older than disk; collapse to refresh", modified: true });
    }
  }
  return drifted.sort((left, right) => left.handle.localeCompare(right.handle));
}

const BASH_FILE_OP_PATTERN =
  /(?:^|[;&|]\s*)(?:sed\s+-(?:n|i)|head\s|tail\s|cat\s+[^<>|&;\n]+)|cat\s*>>?\s*\S|tee\s+\S|perl\s+-i|python3?\b[\s\S]*?\bopen\s*\(/;

interface GenerationToolActivity {
  totalCalls: number;
  lastTurnUsedBashForFiles: boolean;
}

function inspectToolActivity(visibleMessages: readonly import("../domain/state-block.js").MessageLike[]): GenerationToolActivity {
  let totalCalls = 0;
  let lastAssistantCalls: Array<{ name: string; command?: string }> = [];
  for (const message of visibleMessages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls: Array<{ name: string; command?: string }> = [];
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part === null || typeof part !== "object" || part.type !== "toolCall") continue;
      totalCalls += 1;
      const name = typeof part.name === "string" ? part.name : "";
      const args = part.arguments as Record<string, unknown> | undefined;
      const command = typeof args?.command === "string" ? args.command : undefined;
      calls.push(command === undefined ? { name } : { name, command });
    }
    if (calls.length > 0) lastAssistantCalls = calls;
  }
  const lastTurnUsedBashForFiles = lastAssistantCalls.some(
    (call) => call.name === "bash" && call.command !== undefined && BASH_FILE_OP_PATTERN.test(call.command),
  );
  return { totalCalls, lastTurnUsedBashForFiles };
}

/**
 * State-reactive attention cues rendered at the tail of `<carto-state>` (§5.3, §5.7).
 * Every cue is grounded in live facts from the Brain, generation, or jobs table;
 * nothing is emitted when the condition is not present.
 */
export function deriveStateAttention(params: {
  brain: CartoBrain;
  mode: "edit" | "read only";
  pendingCount: number;
  modifiedPins: readonly string[];
  jobs: readonly import("../domain/state-block.js").JobSummaryLine[];
  activity: GenerationToolActivity;
}): string[] {
  const cues: string[] = [];
  if (params.activity.lastTurnUsedBashForFiles) {
    cues.push(
      "Last `bash` call touched files directly -> use `read`/`edit`/`create` instead of `bash` sed/cat/python, and extend one reusable harness rather than creating extra test scripts.",
    );
  }
  if (params.modifiedPins.length > 0) {
    cues.push(
      `Pinned file(s) changed on disk since collapse (${params.modifiedPins.join(", ")}) -> \`read\` current disk content or \`collapse\` at the next boundary to refresh the head.`,
    );
  }
  if (params.activity.totalCalls >= 3 && params.pendingCount === 0) {
    cues.push(
      `Brain has 0 writes after ${params.activity.totalCalls} tool calls this generation -> update your active \`ledger\`/\`atlas\` handle in place now so progress survives collapse.`,
    );
  }
  const activeWork = params.brain.chat.length >= 2 || params.activity.totalCalls >= 2;
  if (params.mode === "edit" && activeWork && params.brain.atlas.length <= 1) {
    const count = params.brain.atlas.length === 0 ? "no nodes" : "only 1 node";
    cues.push(`Atlas has ${count} -> map goals, steps, and atomic leaves in \`atlas\`.`);
  }
  if (activeWork && params.brain.ledger.length === 0) {
    cues.push("Ledger is empty -> track your active leaf, open questions, and current progress in `ledger`.");
  }
  const markedChatCount = params.brain.chat.filter((record) => record.mark !== undefined).length;
  if (params.brain.chat.length >= 8 && markedChatCount < 2) {
    cues.push(
      `Head carries ${params.brain.chat.length} Chat records -> \`mark\` resolved older Chat handles for archive before your next \`collapse\`.`,
    );
  }
  const needyJobs = params.jobs.filter((job) => job.unreadLines > 0 || job.status === "exited");
  if (needyJobs.length > 0) {
    cues.push(
      `Persistent job(s) have unread output or exited (${needyJobs.map((job) => job.handle).join(", ")}) -> call \`proc\` \`read\` or \`stop\`.`,
    );
  }
  return cues;
}

/**
 * Handles of pinned `read` results whose file has changed since the read.
 *
 * This is the sibling §5.5 asks for: a read result carries the path it read, so
 * a pin on it is a promise about that file, and a file that moved on makes the
 * text a stale quotation. Nothing blocks; the block says which handles are stale.
 */
function staleReadResultHandles(brain: CartoBrain, root: string): string[] {
  const names: string[] = [];
  for (const item of brain.ephemera) {
    if (item.pinned === undefined) continue;
    if (item.kind !== "readResult") continue;
    const path = item.entity?.path;
    if (path === undefined) continue;
    const real = lexicalProjectPathSafe(root, path);
    const mtime = real === null ? null : statMtimeSafe(real);
    if (mtime !== null && mtime <= item.createdAt) continue;
    // Ephemera have no Brain handle; the state block names them by id, which is
    // the handle the Context view draws them under.
    names.push(item.id);
  }
  return names.sort((left, right) => left.localeCompare(right));
}

/** Handles of Atlas nodes whose file attachment has drifted. */
export function staleHandles(brain: CartoBrain, root: string): string[] {
  return liveStaleMarks(brain, root).map((mark) => mark.label);
}

/** Everything the block reports, from the Brain and the session, for one request. Exported for the tests. */
export async function renderLiveStateBlock(
  options: CartoExtensionOptions,
  visibleMessages: readonly import("../domain/state-block.js").MessageLike[],
  observe?: (input: StateBlockInput) => void,
): Promise<string> {
  const brain = await options.brain.read();
  const { transcriptTokens, toolWorkTokens, systemTokens } = splitContextMessages(visibleMessages);
  let tree: { root: string; depth: number; lines: string[] };
  try {
    tree = projectTreeBlock(options.root, options.session.tree.anchor, options.session.tree.depth, brain);
  } catch (error) {
    tree = {
      root: options.session.tree.anchor,
      depth: options.session.tree.depth,
      lines: [`(tree unavailable: ${error instanceof Error ? error.message : String(error)})`],
    };
  }
  const pinned: Array<{ handle: string; author: "user" | "agent" }> = [];
  // Pinned ephemera are in the head like anything else that was pinned (§3.2,
  // §5.1), so the block lists them by handle with who kept them.
  for (const item of brain.ephemera) {
    if (item.pinned === undefined) continue;
    const handle = [...(options.session.headEphemera ?? new Map()), ...(options.session.liveEphemera ?? new Map())].find(([, candidate]) => candidate.id === item.id)?.[0]
      ?? handleOf(brain.handles, "ephemera", item.id);
    if (handle !== undefined) pinned.push({ handle, author: item.pinned });
  }
  // A pinned file is a pin like any other and the block lists every pin with
  // its author (§3.2). It is named by the handle the tree gave it, because that
  // is the one handle a file has (§5.4).
  if (brain.files.length > 0) {
    // The tree is rendered from the same anchor and depth the block shows, so
    // the handle a pin is listed under is the one the tree drew for that file.
    const block = projectTreeBlock(options.root, options.session.tree.anchor, options.session.tree.depth, brain);
    for (const file of brain.files) {
      let handle: string | undefined;
      for (const [path, named] of block.handles) if (path === file.path) handle = named;
      pinned.push({ handle: handle ?? file.path, author: file.pinned });
    }
  }
  const marks: MarkLine[] = [];
  const collectMarks = (kind: "atlas" | "ledger" | "chat", records: ReadonlyArray<{ id: string; mark?: { action: string; author: "user" | "agent" } }>): void => {
    for (const record of records) {
      if (record.mark === undefined) continue;
      const handle = handleOf(brain.handles, kind, record.id);
      if (handle === undefined) continue;
      marks.push({ handle, action: record.mark.action as MarkLine["action"], author: record.mark.author });
    }
  };
  collectMarks("atlas", brain.atlas);
  collectMarks("ledger", brain.ledger);
  collectMarks("chat", brain.chat);
  const mode: "edit" | "read only" = options.session.readOnly ? "read only" : "edit";
  const jobs = options.jobs === undefined ? [] : summarizeJobs(options.jobs);
  const stale = staleMarksFor(brain, options.root, options.session, options.markdownPath);
  const activity = inspectToolActivity(visibleMessages);
  const attention = deriveStateAttention({
    brain,
    mode,
    pendingCount: options.session.pending.length,
    modifiedPins: stale.modifiedPins,
    jobs,
    activity,
  });
  const input: StateBlockInput = {
    person: options.session.person,
    contextWindow: options.session.contextWindow,
    collapseWarningPercent: options.session.collapseWarningPercent,
    lastReportedInput: options.session.lastReportedInput,
    lastReportedOutput: options.session.lastReportedOutput,
    systemTokens,
    transcriptTokens,
    toolWorkTokens,
    toolWorkSince: Math.max(0, toolWorkTokens - options.session.toolWorkAtLastReport),
    sizes: {
      atlas: estimatePart(brain.atlas),
      ledger: estimatePart(brain.ledger),
      chat: estimatePart(brain.chat),
      ephemera: estimatePart(brain.ephemera),
    },
    pending: options.session.pending,
    pinned,
    marks,
    ...(options.session.liveEphemera === undefined ? {} : { working: [...options.session.liveEphemera].map(([handle, item]) => ({ handle, kind: item.kind, text: item.text })) }),
    ...(jobs.length === 0 ? {} : { jobs }),
    ...(attention.length === 0 ? {} : { attention }),
    // Atlas notes drift, pinned files gone or modified since freeze drift, and
    // pinned `read` results whose file changed are the same fact about drift (§5.5).
    stale: stale.items,
    resolveHandle: (kind, id) => handleOf(brain.handles, kind, id),
    mode,
    projectRoot: options.root,
    tree,
  };
  observe?.(input);
  return renderStateBlock(input);
}

/**
 * `bash`, from the package, with Carto's sentence about where it runs. The
 * package keeps its own bounds and says them (§1); the shell is trusted in both
 * modes and is not a sandbox (§6.1).
 */
export function bashTool(): ToolRegistration {
  const base = createBashTool();
  return defineTool({
    ...base,
    description: `${base.description ?? "Run a command."} Runs in the project root for shell commands (builds, tests, linters, git). Do not use bash to read, create, or edit project files (use read, edit, or create) or for long-lived interactive processes (use proc). Not sandboxed in read only mode, where what stops a command that writes is you.`,
  });
}

export function createCartoExtension(options: CartoExtensionOptions) {
  // pi rebuilds the provider body from whatever `beforeRequest` returns; the
  // block message is a plain user message by construction, so the cast only
  // widens what the compiler can prove, never what is sent.
  const asPiMessages = (messages: readonly unknown[]): readonly Message[] => messages as readonly Message[];
  const now = () => options.now?.() ?? Date.now();
  return defineExtension({
    name: "carto",
    // A rest is durable, so its task is part of what this extension installs;
    // `sleep` creates one and the harness runs it (§10).
    tasks: [SleepTask, TreeReadTask],
    sections: [
      /**
       * The instructions, first: §5.1 puts the system prompt ahead of the tools
       * and the Brain. pi appends an agent's own `instructions` after every
       * extension section, which would put them last, so they are a section of
       * this extension and sit before the projection.
       */
      section("carto-instructions", () => cartoInstructions(options.session.person), { tag: false }),
      /**
       * The frozen projection for this generation: written once at creation,
       * read verbatim ever since, so the prompt prefix stays byte-stable
       * between collapses. A crash reopens the identical bytes.
       *
       * No fallback when the read fails. A live re-projection from the Brain
       * would drift as the agent writes, breaking the head from a transient
       * error; instead the read throws and pi keeps the section's shown text,
       * so the head stays byte-identical. The file is sealed read-only and
       * written atomically, so a failure here is a real problem, not a state
       * to paper over by changing the prompt.
       */
      section(
        "carto-context",
        async () => readFile(options.markdownPath, "utf8"),
        { tag: false },
      ),
    ],
    hooks: [
      hook(CompactionTask, {
        beforeCompact: () => {
          // Compaction is declined: the context is gardened by collapse, not
          // by Pi rewriting the transcript. The collapse rebuilds from the
          // Brain — the same rebuild the agent's collapse tool asks for.
          if (options.session.collapseRequested === null) {
            options.session.collapseRequested = "context overflow; compaction declined";
            options.session.collapseTrigger = "automatic";
          }
          return { decline: true };
        },
      }),
      hook(GenerationTask, {
        beforeRequest: async (request) => {
          const visible = stripStateBlocks(request.messages);
          await options.session.refreshHeadEphemera?.();
          if (options.session.loadPromptItems !== undefined) {
            const items = await options.session.loadPromptItems();
            const handles = promptHandles(items, options.session.headEphemeraCount ?? 0);
            const live = new Map<string, import("../domain/records.js").PinnedEphemeral>();
            for (const item of items) {
              if (item.item === undefined) continue;
              const handle = item.kind === "person" ? handles.person(item.key) : item.kind === "result" ? handles.result(item.key) : handles.ephemeral(item.key);
              if (handle !== undefined) live.set(handle, item.item);
            }
            options.session.liveEphemera = live;
          }
          // Only an actual request sets the accounting baseline. UI previews
          // also render the state block and must not change an in-flight one.
          options.session.toolWorkAtLastRequest = splitContextMessages(visible).toolWorkTokens;
          const block = await renderLiveStateBlock(options, visible, (input) => {
            const work = options.session.work;
            if (work.requests === 0) work.startFill = contextFillPercent(input);
            work.requests += 1;
          });
          options.session.lastStateBlock = block;
          return { messages: asPiMessages(appendStateBlock(visible, block, now())) };
        },
        afterResponse: (message) => {
          const usage = message.usage;
          // Pi separates cached tokens from input; all of them occupy context.
          const input = usage === undefined ? 0 : usage.input + usage.cacheRead + usage.cacheWrite;
          if (input > 0) {
            options.session.lastReportedInput = input;
            options.session.lastReportedOutput = usage?.output ?? 0;
            options.session.toolWorkAtLastReport = options.session.toolWorkAtLastRequest + splitContextMessages([message]).toolWorkTokens;
          }
          options.session.onTelemetry?.();
          const session = options.session;
          const worked = (message.stopReason === "stop" || message.stopReason === "toolUse")
            && !message.content.some((part) => part.type === "toolCall" && part.name === "collapse");
          if (worked) session.work.steps += 1;
          // pi never retries an overflow with compaction off, and it fails the
          // run before `onYield`. The provider's own error is the signal, so the
          // collapse is asked for here, where the failure is still seen.
          if (isContextOverflow(message, session.contextWindow > 0 ? session.contextWindow : undefined)) {
            if (session.collapseRequested === null) {
              session.collapseRequested = `the context overflowed${message.errorMessage === undefined ? "" : `: ${message.errorMessage}`}`;
              session.collapseTrigger = "automatic";
            }
          }
        },
        onYield: (message) => {
          const session = options.session;
          // A collapse already asked for ends the run; the host rebuilds and resumes.
          if (session.collapseRequested !== null) return undefined;
          // A `length` stop below the output limit pi meant to allow is the one
          // pi says may be context pressure: one collapse is the bounded retry,
          // and the host stops if the rebuilt context does no better. A stop at
          // the limit is ordinary — the model simply wrote that much — and goes
          // on as any answer does.
          if (message.stopReason === "length" && isRecoverableLength(message, session.desiredMaxOutput)) {
            session.collapseRequested = `a response stopped at its length limit with room left in its output (${message.usage.output} of ${session.desiredMaxOutput} tokens)`;
            session.collapseTrigger = "automatic";
            return undefined;
          }
          return { continue: STATE_BLOCK_MARKER };
        },
        afterRun: async (run, api, context) => {
          if (run.reason !== "terminate") return;
          const answer = (await api.entry(run.answer, context))?.model?.[0];
          if (answer?.role !== "assistant") return;
          const calls = answer.content.filter((part) => part.type === "toolCall");
          // A tree-only terminal round asks for the new block. Sleep and
          // collapse deliberately stop, even if the model called tree alongside.
          if (calls.length === 0 || !calls.every((call) => call.name === "tree")) return;
          return { tasks: [runEndTask(TreeReadTask, {})] };
        },
      }),
    ],
    tools: [
      ...createTools({
        root: options.root,
        brain: options.brain,
        session: options.session,
        ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
      }),
      // `bash` is pi-durable's own (§7, §12): it runs through the env wired in
      // live-session, an abort kills the command, and its retained tail and
      // spill file are the package's bounds, stated in its description (§1).
      bashTool(),
    ],
  });
}
