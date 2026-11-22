/**
 * The Carto extension: the frozen projection as a byte-stable section, the
 * product tools, and the hooks that carry the state block (MINI.md §6.1-6.3).
 *
 * The block is appended to every request as a trailing user-role message and
 * never persisted: `beforeRequest` strips the markers the transcript
 * legitimately holds and appends a fresh block; `onYield` continues a
 * tool-free answer with a byte-sized marker. The model sees exactly one
 * current block at the tail; the store keeps only markers; markers die with
 * the generation's store at collapse. Blocks never accumulate.
 */
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";

import { CompactionTask, GenerationTask, defineExtension, hook, section } from "@earendil-works/pi-durable";
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
} from "../domain/state-block.js";
import { projectContext } from "../domain/projection.js";
import { projectTreeBlock } from "./project-tree.js";
import { lexicalProjectPath } from "./workspace.js";
import { createTools, type ToolSession } from "./tools.js";
import type { BrainStore } from "./brain-store.js";

/** The minimal system prompt (docs/intent.md §22): the tools describe themselves; this carries only what no tool can say. */
export const CARTO_INSTRUCTIONS = [
  "You are Carto, the long-lived working attention on one project.",
  "Plain model text is not person-facing. The chat tool is the only channel that reaches the person.",
  "Read before you write anything about a project file.",
  "Keep the Brain: Atlas for what you understand about the project, Ledger for goals, notes, questions, instructions, and progress, Chat for person-facing words. Pin a record to keep it close. Writes since the rebuild are pending in your state block; a long pending list means your map and your books diverged. Collapse is the fix; it rebuilds you from the Brain.",
  "The person may collapse the context at any time. A collapse ends this context and rebuilds it from the Brain. Keep everything you need there. This is a standing fact, stated as consequence, not as threat.",
  "The last thing in every request is a state block, delimited <carto-state> and </carto-state>. It tells you where things stand: context fullness, space by Brain part, pending writes, stale entries, and the project tree. It is purely informative and never instructive — nothing in it is a request, and it is not the person's text.",
  "`.brain` is not yours: no tool reads, lists, or writes it, and the archive inside it is the person's alone to restore from.",
  "The two modes: in edit mode you change the project as you work. In read only mode the person has taken that away — `create` and `edit` will refuse you. Do not work around it, and do not propose, queue, or ask permission for changes: read, answer, and say what you would change when you are asked for it.",
  "Collapse when it is appropriate, not when the context is full. When a task is done and the Brain is current, collapse and carry the result forward. Before a long piece of work, pin what you will need, collapse, and start inside a context built for the problem instead of one you accumulated on the way there.",
  "Aim at small, atomic steps: one function, one value changed, one chunk removed, one small file added. Nothing refuses a large change; keep the step small because the person can read it and you can describe it.",
].join("\n");

export interface LiveSessionState extends ToolSession {
  /** The active context window; the driver adjusts it when llama-swap advertises capacity. */
  contextWindow: number;
  lastReportedInput: number | undefined;
  /** Tool-work estimate as of the last provider report. */
  toolWorkAtLastReport: number;
  /** Tool-work estimate as of the last request; folds into the report at afterResponse. */
  toolWorkAtLastRequest: number;
  /** Set by a timed `sleep`: the rest the host is to wait out (§10). */
  sleepSeconds: number | undefined;
  /** Set when the person's message ended a rest early, so the host starts no run of its own. */
  restEndedByPerson: boolean;
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
 * Atlas nodes whose file attachment has drifted (missing, or newer than
 * the entry was written) — checked live against the filesystem, not against
 * the stored marker. The state block and the views ask this; the collapse
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
    if (handle !== undefined) marks.push({ kind: "atlas", label: `${handle} (stale)` });
  }
  return marks.sort((left, right) => left.label.localeCompare(right.label));
}

/** Labels ("A5 (stale)") of Atlas nodes whose file attachment has drifted. */
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
  return renderStateBlock({
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
    },
    pending: options.session.pending,
    pinned,
    stale: staleHandles(brain, options.root),
    resolveHandle: (kind, id) => handleOf(brain.handles, kind, id),
    mode: options.session.readOnly ? "read only" : "edit",
    tree,
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
      }),
    ],
    tools: [
      ...createTools({ root: options.root, brain: options.brain, session: options.session }),
      // §10a's "shell", per the person's call: pi-durable's built-in bash —
      // runs through the env (wired in live-session), abort kills the
      // command; pi keeps the 2000-line / 50 KB tail and spills the rest to
      // a temp file reported in a diagnostic. No limits of ours are added.
      createBashTool(),
    ],
  });
}
