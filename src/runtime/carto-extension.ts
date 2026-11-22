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

import { handleOf } from "../domain/handles.js";
import type { CartoBrain } from "../domain/records.js";
import {
  STATE_BLOCK_MARKER,
  appendStateBlock,
  estimateSerialized,
  renderStateBlock,
  splitContextMessages,
  stripStateBlocks,
  type MarkLine,
} from "../domain/state-block.js";
import { projectContext } from "../domain/projection.js";
import { projectTreeBlock } from "./project-tree.js";
import { lexicalProjectPath } from "./workspace.js";
import { SleepTask } from "./sleep-task.js";
import { TreeReadTask } from "./tree-read-task.js";
import { createTools, type ToolSession } from "./tools.js";
import type { BrainStore } from "./brain-store.js";

/**
 * The system prompt (§7): the tools describe themselves, so this carries only
 * what no single description can say — how to read the environment, how to
 * think about a context that is maintained rather than accumulated, what to do
 * with a turn, and the things nothing can enforce.
 */
export function cartoInstructions(person: string): string {
  return [
    `You are Carto: the working attention on one project, kept for ${person}. You work in small steps, and the context you think in is a thing you maintain rather than something that piles up behind you.`,
    `Everything you can see carries a short handle: H is this text, Y1 and up are your tools, A, L, and C are the Brain's records, U is ${person}'s messages, X is your own working, B is the state block, T1 is the tree, F and D are files and directories in it, R and S are the results of tool calls and of the shell, and P names a pin by the handle of the entry it marks. A handle is how you point at a thing — tools take one, and it is how ${person} and you refer to the same item.`,
    `Your plain text is your own thinking; it reaches no one. ${person} hears you through \`chat\`, so when there is something they need — a result, a decision, a question — say it there, plainly, once. A turn in which you have nothing to tell them needs no \`chat\` call.`,
    `The Brain is what you bring forward. Atlas holds what you understand about the project, Ledger what you are working on, Chat what you have said to ${person}. A plan lives here before it is code: the goal, then the steps in order, written where the next step can read them. Write down what you will need, then trust it: a small context is only worth having if your notes are the reason you do not re-derive what you already decided, and do not re-read what you already read unless it has changed.`,
    "You do not see the world change. Nothing tells you that a file was edited or a record was moved while you were away, so read before you write about a file, and when the state block calls something stale, believe it: the file moved on after your note was written, or after you read it. A pinned file is the exception and the reason to pin one: it is read again at every collapse, so the head holds the file as it now stands, where a pinned reading of it holds the bytes of that reading until it is called stale.",
    "Every request ends with a state block between `<carto-state>` and `</carto-state>`: the mode, how full the context is, what was written since the rebuild, what has gone stale, the project tree, the pins, the marks. It arrives as a turn because a turn is how you start. There is no nudge and no “you are not done” — you read the state and act on it, or you stop.",
    `A turn ends when your reply carries no tool call. If there is work, do it. If there is nothing to do and nothing to say, \`sleep\` — that is the honest end of a turn and the only way you stop. Do not greet, do not announce that you are idle, and do not answer a state block as though ${person} had spoken.`,
    `The context may collapse at any time, yours or ${person}'s, and it is rebuilt from the Brain alone. Nothing outside the Brain survives it. Collapse when it is appropriate: when a piece of work is finished and the Brain holds its result, or before a long piece of work, after pinning what you will need, so you begin inside a context built for the problem rather than one you accumulated on the way to it.`,
    "A step is small against the plan and not against the file: one function, one chunk, or the least scaffolding the next step needs, so each can be run and judged. Nothing refuses a large change; the plan is what lets you choose its size.",
    `Carto is in edit mode or read only mode. Edit mode is the default and you change the project as you work. In read only mode ${person} has decided you make no destructive change: \`create\` and \`edit\` refuse, and the state block says so. There is nothing to propose, queue, or ask permission for — read, answer, and say what you would change when you are asked.`,
    "`.brain` holds Carto's own storage. You never read, list, or write it and no tool will. Whatever you let go of — swept at a collapse, or deleted — is gone for good, and nothing you can reach will bring it back.",
  ].join("\n");
}

export interface LiveSessionState extends ToolSession {
  /** What the agent calls the person: the configured name, or the launching account. */
  person: string;
  /** The active context window; the driver adjusts it when llama-swap advertises capacity. */
  contextWindow: number;
  /**
   * The person has paused the agent (§9). Pausing is not an interrupt and is
   * never told to the agent, so nothing in the block mentions it; the flag is
   * here because the UI and the driver read the one state, and here is where
   * this session's state lives.
   */
  paused: boolean;
  lastReportedInput: number | undefined;
  /** Tool-work estimate as of the last provider report. */
  toolWorkAtLastReport: number;
  /** Tool-work estimate as of the last request; folds into the report at afterResponse. */
  toolWorkAtLastRequest: number;
}

export interface CartoExtensionOptions {
  root: string;
  brain: BrainStore;
  session: LiveSessionState;
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
): Array<{ handle: string; why: string }> {
  const marks: Array<{ handle: string; why: string }> = [];
  for (const mark of liveStaleMarks(brain, root)) {
    marks.push({ handle: mark.label, why: "the file changed after this note" });
  }
  for (const handle of staleFileHandles(brain, root, session)) {
    marks.push({ handle, why: "pinned, and the file is gone" });
  }
  for (const handle of staleReadResultHandles(brain, root)) {
    marks.push({ handle, why: "a pinned reading, and the file has changed since" });
  }
  return marks;
}

/**
 * Handles of pinned files that cannot be read as they were pinned: gone, or not
 * a text file. A pin is a promise the head holds the file, so a pin that cannot
 * be kept says so (§5.1, §5.5).
 */
function staleFileHandles(brain: CartoBrain, root: string, session: CartoExtensionOptions["session"]): string[] {
  if (brain.files.length === 0) return [];
  const tree = projectTreeBlock(root, session.tree.anchor, session.tree.depth, brain);
  const names: string[] = [];
  for (const file of brain.files) {
    const real = lexicalProjectPathSafe(root, file.path);
    const readable = real !== null && statMtimeSafe(real) !== null;
    if (readable) continue;
    for (const [path, handle] of tree.handles) if (path === file.path) names.push(handle);
  }
  return names.sort((left, right) => left.localeCompare(right));
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
): Promise<string> {
  const brain = await options.brain.read();
  const { transcriptTokens, toolWorkTokens, systemTokens } = splitContextMessages(visibleMessages);
  options.session.toolWorkAtLastRequest = toolWorkTokens;
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
  for (const node of brain.atlas) {
    if (node.pinned === undefined) continue;
    const handle = handleOf(brain.handles, "atlas", node.id);
    if (handle !== undefined) pinned.push({ handle, author: node.pinned });
  }
  // Pinned ephemera are in the head like anything else that was pinned (§3.2,
  // §5.1), so the block lists them by handle with who kept them.
  for (const item of brain.ephemera) {
    if (item.pinned === undefined) continue;
    const handle = handleOf(brain.handles, "ephemera", item.id);
    if (handle !== undefined) pinned.push({ handle, author: item.pinned });
  }
  for (const entry of brain.ledger) {
    if (entry.pinned === undefined) continue;
    const handle = handleOf(brain.handles, "ledger", entry.id);
    if (handle !== undefined) pinned.push({ handle, author: entry.pinned });
  }
  for (const record of brain.chat) {
    if (record.pinned === undefined) continue;
    const handle = handleOf(brain.handles, "chat", record.id);
    if (handle !== undefined) pinned.push({ handle, author: record.pinned });
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
  return renderStateBlock({
    person: options.session.person,
    contextWindow: options.session.contextWindow,
    lastReportedInput: options.session.lastReportedInput,
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
    // Atlas notes drift, a pinned file that is gone drifts, and a pinned `read`
    // result whose file changed is the same fact about a quotation (§5.5).
    stale: staleMarksFor(brain, options.root, options.session),
    resolveHandle: (kind, id) => handleOf(brain.handles, kind, id),
    mode: options.session.readOnly ? "read only" : "edit",
    projectRoot: options.root,
    tree,
  });
}

/**
 * `bash`, from the package, with Carto's sentence about where it runs. The
 * package keeps its own bounds and says them (§1); the shell is trusted in both
 * modes and is not a sandbox (§6.1).
 */
function bashTool(): ToolRegistration {
  const base = createBashTool();
  return defineTool({
    ...base,
    description: `${base.description ?? "Run a command."} The command runs in the project root. The shell is not sandboxed in read only mode, where what stops a command that writes is you.`,
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
       * The frozen projection for this generation: written once at creation,
       * read verbatim ever since, so the prompt prefix stays byte-stable
       * between collapses. A crash reopens the identical bytes.
       */
      section(
        "carto-context",
        async () => readFile(options.markdownPath, "utf8").catch(async () => projectContext(await options.brain.read()).text),
        { tag: false },
      ),
    ],
    hooks: [
      hook(CompactionTask, {
        beforeCompact: () => {
          // Compaction is declined: the context is gardened by collapse, not
          // by Pi rewriting the transcript. The collapse rebuilds from the
          // Brain — the same rebuild the agent's collapse tool asks for.
          options.session.collapseRequested ??= "context overflow; compaction declined";
          return { decline: true };
        },
      }),
      hook(GenerationTask, {
        beforeRequest: async (request) => {
          const visible = stripStateBlocks(request.messages);
          const block = await renderLiveStateBlock(options, visible);
          return { messages: asPiMessages(appendStateBlock(visible, block, now())) };
        },
        afterResponse: (message) => {
          const usage = message.usage;
          if (usage !== undefined && typeof usage.input === "number" && usage.input > 0) {
            options.session.lastReportedInput = usage.input;
          }
          options.session.toolWorkAtLastReport = options.session.toolWorkAtLastRequest;
        },
        onYield: () => ({ continue: STATE_BLOCK_MARKER }),
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
      ...createTools({ root: options.root, brain: options.brain, session: options.session }),
      // `bash` is pi-durable's own (§7, §12): it runs through the env wired in
      // live-session, an abort kills the command, and its retained tail and
      // spill file are the package's bounds, stated in its description (§1).
      bashTool(),
    ],
  });
}
