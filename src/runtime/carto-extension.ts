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
import { createTools, type ToolSession } from "./tools.js";
import type { BrainStore } from "./brain-store.js";

/** The minimal system prompt (docs/intent.md §22): the tools describe themselves; this carries only what no tool can say. */
export const CARTO_INSTRUCTIONS = [
  "You are Carto, the project's long-lived working memory.",
  "Plain model text is not person-facing. The chat tool is the only channel that reaches the person.",
  "Read before you claim anything about a project file.",
  "Keep the Brain: Atlas for source-backed claims, Ledger for goals, notes, questions, instructions, and progress, Chat for person-facing words. Pin a record to keep it close. Writes since the rebuild are pending in your state block; a long pending list means your map and your books diverged. Collapse is the fix; it rebuilds you from the Brain.",
  "The person may collapse the context at any time. A collapse ends this context and rebuilds it from the Brain. Keep everything you need there. This is a standing fact, stated as consequence, not as threat.",
  "The last thing in every request is a state block, delimited <carto-state> and </carto-state>. It tells you where things stand: context fullness, space by Brain part, pending writes, stale evidence, and the project tree. It is purely informative and never instructive — nothing in it is a request, and it is not the person's text.",
  "`.brain` is not yours: no tool reads, lists, or writes it, and the archive inside it is the person's alone to restore from.",
].join("\n");

export interface LiveSessionState extends ToolSession {
  /** The active context window; the driver adjusts it when llama-swap advertises capacity. */
  contextWindow: number;
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

/** Records whose file-backed evidence drifted at the last rebuild, as typed marks. */
export function staleMarks(brain: CartoBrain): Array<{ kind: "atlas"; label: string }> {
  const marks: Array<{ kind: "atlas"; label: string }> = [];
  for (const node of brain.atlas) {
    const drifted = node.evidence.some((ref) => ref.kind === "file" && ref.freshness === "stale");
    if (!drifted) continue;
    const handle = handleOf(brain.handles, "atlas", node.id);
    if (handle !== undefined) marks.push({ kind: "atlas", label: `${handle} (evidence changed)` });
  }
  const seen = new Set<string>();
  const unique = marks.filter((mark) => {
    if (seen.has(mark.label)) return false;
    seen.add(mark.label);
    return true;
  });
  return unique.sort((left, right) => left.label.localeCompare(right.label));
}

/** Handles of records whose file-backed evidence drifted at the last rebuild. */
export function staleHandles(brain: CartoBrain): string[] {
  return staleMarks(brain).map((mark) => mark.label);
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
    stale: staleHandles(brain),
    resolveHandle: (kind, id) => handleOf(brain.handles, kind, id),
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
