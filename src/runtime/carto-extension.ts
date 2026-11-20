import { arr, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { CompactionTask, defineExtension, defineTool, GenerationTask, hook, section } from "@earendil-works/pi-durable";
import type { AnyTask } from "@earendil-works/pi-durable";

import { projectContext, renderContextPlan } from "../domain/context.js";
import {
  handleOf,
  resolveHandle,
  resolveHandleOfKind,
  resolveHandlesOfKind,
} from "../domain/handles.js";
import { readFile } from "node:fs/promises";
import type { AtlasEdge, AtlasEdgeKind, SourceRef, WakeEntry } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { pathFingerprint } from "./path-wake-task.js";
import { parseTimeWakeCondition } from "./wake.js";
import { digestProjectFile, inspectProjectFile, resolveProjectWatchPath } from "./workspace.js";
import {
  STATE_BLOCK_MARKER,
  appendStateBlock,
  renderStateBlock,
  stripStateBlocks,
  type PendingWrite,
} from "./state-block.js";
import { atlasPathMarks, renderProjectTree } from "./tree.js";

/**
 * Public generation-local handles are the only record references a model may
 * use. A private durable ID never appears in a tool schema or a tool result.
 */
const HandleRef = str({ minLength: 1, maxLength: 8 });
const Text = str({ minLength: 1, maxLength: 24_000 });
const OptionalText = opt(str({ maxLength: 24_000 }));
const Status = oneOf(["open", "answered", "closed"] as const);
const LedgerKind = oneOf(["goal", "note", "question"] as const);
const WakeKind = oneOf(["time", "path"] as const);
const PinRequest = union([
  obj({
    action: lit("add"),
    item: Text,
    reason: str({ minLength: 1, maxLength: 1000 }),
    source: union([
      obj({
        kind: lit("file"),
        path: str({ minLength: 1, maxLength: 4096 }),
        startLine: int({ minimum: 1 }),
        endLine: int({ minimum: 1 }),
        digest: str({ minLength: 1, maxLength: 128 }),
        excerpt: Text,
      }),
      obj({ kind: lit("context"), excerpt: Text }),
    ]),
  }),
  obj({ action: lit("remove"), handle: HandleRef }),
]);
const WakeRequest = union([
  obj({
    action: lit("arm"),
    handle: opt(HandleRef),
    kind: WakeKind,
    condition: str({ minLength: 1, maxLength: 4096 }),
    reason: str({ minLength: 1, maxLength: 1000 }),
  }),
  obj({ action: lit("cancel"), handle: HandleRef, reason: str({ minLength: 1, maxLength: 1000 }) }),
  obj({ action: lit("view"), handle: opt(HandleRef) }),
]);

export interface CartoExtensionOptions {
  brain: BrainStore;
  projectRoot: string;
  /** The generation file that owns this live context. */
  contextId: string;
  contextBudget: number;
  durableTasks?: readonly AnyTask[];
  /**
   * Where the prompt the model was sent is recorded, plus the provider's own
   * usage for it. The state block reads this to report the context honestly.
   *
   * Optional so a test or a headless host can leave it out; when it is present
   * the generation hooks keep it current.
   */
  promptStore?: import("./prompt-store.js").PromptStore;
  /**
   * Called when the agent's collapse tool or a declined compaction asks for a
   * collapse. The project decides when to rotate; nothing here mutates the
   * Brain or touches the live store.
   */
  onCollapseRequest?: () => void;
  /** The model's context window, from the Pi catalog. */
  contextWindow?: number;
  /**
   * The state block (§12, §20, §21). Present in production; a test may leave
   * it out, in which case nothing is injected and `onYield` does not fire a
   * continuation — the run ends the way Pi ends it by default.
   */
  stateBlock?: {
    /** The frozen projection for this generation; read verbatim every request. */
    projectionPath: string;
    /** The frozen per-part token sums for the block's space line. */
    partsPath: string;
    /** The pending-writes source, read at request time. */
    pendingWrites: () => readonly PendingWrite[];
  };
}

export function createCartoExtension(options: CartoExtensionOptions) {
  return defineExtension({
    name: "carto",
    sections: [
      /**
       * The frozen projection. Written once at generation creation and read
       * verbatim ever since, so the section is byte-stable between collapses
       * and the prompt prefix is not invalidated by Brain writes. A crash
       * finds the same file (or renders once from the Brain, if the crash
       * happened during creation) and gets the same bytes either way.
       */
      section(
        "carto-context",
        async () => {
          if (options.stateBlock !== undefined) {
            const frozen = await readFile(options.stateBlock.projectionPath, "utf8").catch(() => undefined);
            if (frozen !== undefined) return frozen;
          }
          const brain = await options.brain.read();
          return renderContextPlan(projectContext(brain, { budget: options.contextBudget }));
        },
        { tag: false },
      ),
    ],
    ...(options.durableTasks === undefined ? {} : { tasks: options.durableTasks }),
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async () => {
          // Compaction is declined: the context is gardened by collapse, not
          // by Pi rewriting the transcript. The project rotates when the run
          // ends.
          options.onCollapseRequest?.();
          return { decline: true };
        },
      }),
      /**
       * The prompt, as sent.
       *
       * `beforeProviderRequest` receives the messages Pi assembled for this
       * request, in the provider's order, after every section and every tool
       * definition has been applied. Recording them is what lets the state
       * block report what the last request carried: this is the only place
       * Carto can obtain a prompt that was actually sent.
       */
      ...(options.stateBlock === undefined
        ? []
        : [hook(GenerationTask, stateBlockHooks({ ...options, stateBlock: options.stateBlock }))]),
      hook(GenerationTask, {
        beforeProviderRequest: (request) => {
          // The payload is the provider's own body. It is recorded as-is; the
          // state block reads it, and a field it does not know still reaches
          // whatever reports context pressure, because the record is this JSON.
          options.promptStore?.observe(request.payload as import("./prompt-store.js").ProviderPayload);
          // Returning nothing keeps the payload exactly as Pi built it.
          return undefined;
        },
        afterResponse: (message) => {
          if (options.promptStore === undefined) return;
          const usage = message.usage;
          options.promptStore.recordUsage({
            input: usage.input,
            output: usage.output,
            totalTokens: usage.totalTokens,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          });
        },
      }),
    ],
    tools: [
      defineTool({
        name: "chat",
        description: "Send one deliberate message to the person. Use this tool for all person-facing text.",
        parameters: obj({ text: Text }),
        replay: "safe",
        execute: async (args, api) => {
          await options.brain.apply({
            kind: "chat.record",
            record: { id: `agent:${api.callId}`, author: "agent", text: args.text, createdAt: api.now(), updatedAt: api.now() },
          });
          return textOutput("Chat message saved.");
        },
      }),
      defineTool({
        name: "ledger",
        description:
          "Create or update one durable goal, note, or question. Give the handle of the Ledger record to update, or leave it out to create one.",
        parameters: obj({
          handle: opt(HandleRef),
          kind: LedgerKind,
          text: Text,
          status: Status,
          answer: OptionalText,
          evidence: opt(arr(HandleRef, { maxItems: 32 })),
        }),
        replay: "safe",
        execute: async (args, api) => {
          const brain = await options.brain.read();
          const previous = args.handle === undefined ? undefined : findLedger(brain, args.handle);
          const id = previous?.id ?? `ledger:${api.callId}`;
          const evidenceIds = resolveHandlesOfKind(brain.handles, args.evidence ?? [], "ledger");
          await options.brain.apply({
            kind: "ledger.upsert",
            entry: {
              id,
              kind: args.kind,
              text: args.text,
              status: args.status,
              answer: args.answer === undefined ? null : { text: args.answer, evidenceIds },
              createdAt: previous?.createdAt ?? api.now(),
              updatedAt: api.now(),
            },
          });
          return textOutput(`Ledger ${handleOf((await options.brain.read()).handles, "ledger", id) ?? "record"} saved.`);
        },
      }),
      defineTool({
        name: "atlas",
        description:
          "Create or update one short, source-backed Atlas claim. Give the handle of the Atlas record to update, or leave it out to create one.",
        parameters: obj({
          handle: opt(HandleRef),
          title: str({ minLength: 1, maxLength: 240 }),
          claim: Text,
          evidence: arr(
            obj({
              path: str({ minLength: 1, maxLength: 4096 }),
              startLine: int({ minimum: 1 }),
              endLine: int({ minimum: 1 }),
              digest: str({ minLength: 1, maxLength: 128 }),
              excerpt: Text,
            }),
            { minItems: 1, maxItems: 12 },
          ),
          edges: opt(
            arr(
              obj({
                kind: oneOf(["replaces", "depends-on", "contradicts"] as const),
                handle: HandleRef,
              }),
              { maxItems: 32 },
            ),
          ),
        }),
        replay: "safe",
        execute: async (args, api) => {
          const evidence = await Promise.all(args.evidence.map((item) => verifyFileEvidence(options.projectRoot, item)));
          const brain = await options.brain.read();
          const previous = args.handle === undefined ? undefined : findAtlas(brain, args.handle);
          const id = previous?.id ?? `atlas:${api.callId}`;
          const edges: AtlasEdge[] = (args.edges ?? []).map((edge) => {
            const resolved = resolveHandleOfKind(brain.handles, edge.handle, ["atlas"]);
            return { kind: edge.kind as AtlasEdgeKind, target: resolved.id };
          });
          await options.brain.apply({
            kind: "atlas.upsert",
            node: {
              id,
              title: args.title,
              claim: args.claim,
              evidence,
              edges,
              createdAt: previous?.createdAt ?? api.now(),
              updatedAt: api.now(),
            },
          });
          return textOutput(`Atlas ${handleOf((await options.brain.read()).handles, "atlas", id) ?? "record"} saved.`);
        },
      }),
      defineTool({
        name: "inspect",
        description: "Read a bounded text file range inside the project root.",
        parameters: obj({
          path: str({ minLength: 1, maxLength: 4096 }),
          startLine: int({ minimum: 1 }),
          endLine: int({ minimum: 1 }),
        }),
        replay: "safe",
        execute: async (args) => {
          const inspected = await inspectProjectFile(options.projectRoot, args);
          return textOutput(
            `${inspected.path}:${inspected.startLine}-${inspected.endLine}\ndigest: ${inspected.digest}\n\n${inspected.excerpt}`,
          );
        },
      }),
      defineTool({
        name: "pin",
        description:
          "Add or remove one agent carry pin. A file source needs exact inspected evidence. A context source keeps a selected current-context item across collapses until you remove it. Remove a pin by its short handle.",
        parameters: PinRequest,
        replay: "safe",
        execute: async (args, api) => {
          if (args.action === "remove") {
            const brain = await options.brain.read();
            const resolved = resolveHandleOfKind(brain.handles, args.handle, ["pin"]);
            if (brain.userPins.some((pin) => pin.id === resolved.id)) {
              throw new Error(`Pin ${args.handle.toUpperCase()} belongs to the person. Only the person can remove it.`);
            }
            if (!brain.carryPins.some((pin) => pin.id === resolved.id)) {
              throw new Error(`Carto does not know the pin ${args.handle.toUpperCase()}. Use a handle from the current context.`);
            }
            await options.brain.apply({ kind: "record.delete", target: { target: "carry-pin", id: resolved.id } });
            return textOutput(`Pin ${args.handle.toUpperCase()} removed.`);
          }
          const source: SourceRef =
            args.source.kind === "file"
              ? await verifyFileEvidence(options.projectRoot, args.source)
              : { kind: "context", contextId: options.contextId, excerpt: args.source.excerpt, freshness: "fresh" };
          const id = `carry:${api.callId}`;
          await options.brain.apply({
            kind: "pin.carry.add",
            pin: { id, item: args.item, reason: args.reason, source, createdAt: api.now() },
          });
          const handle = handleOf((await options.brain.read()).handles, "pin", id);
          return textOutput(handle === undefined ? "Carry pin saved." : `Carry pin ${handle} saved.`);
        },
      }),
      defineTool({
        name: "wake",
        description:
          "Arm, cancel, or view durable time and path wakes. Use a short wake handle to cancel, view, or update a wake. A time condition is ISO 8601 or Unix milliseconds.",
        parameters: WakeRequest,
        replay: "safe",
        execute: async (args, api) => {
          const brain = await options.brain.read();
          if (args.action === "view") {
            const wants = args.handle === undefined ? undefined : resolveHandleOfKind(brain.handles, args.handle, ["wake"]);
            const wakes = wants === undefined ? brain.wakes : brain.wakes.filter((wake) => wake.id === wants.id);
            return textOutput(renderWakes(brain, wakes));
          }

          if (args.action === "cancel") {
            const wants = resolveHandleOfKind(brain.handles, args.handle, ["wake"]);
            const previous = brain.wakes.find((wake) => wake.id === wants.id);
            if (previous === undefined) return textOutput(`Wake ${args.handle.toUpperCase()} is not active.`);
            await options.brain.apply({
              kind: "wake.upsert",
              wake: { ...previous, status: "cancelled", reason: args.reason },
            });
            return textOutput(`Wake ${args.handle.toUpperCase()} cancelled.`);
          }

          const existing = args.handle === undefined ? undefined : resolveHandle(brain.handles, args.handle);
          if (existing !== undefined && existing.kind !== "wake") {
            throw new Error(`The handle ${args.handle} does not name a wake.`);
          }
          if (args.kind === "time") parseTimeWakeCondition(args.condition);
          else {
            await resolveProjectWatchPath(options.projectRoot, args.condition);
            await pathFingerprint(options.projectRoot, args.condition);
          }
          const previous = existing === undefined ? undefined : brain.wakes.find((wake) => wake.id === existing.id);
          const id = previous?.id ?? `wake:${api.callId}`;
          await options.brain.apply({
            kind: "wake.upsert",
            wake: {
              id,
              kind: args.kind,
              condition: args.condition,
              status: "armed",
              reason: args.reason,
              createdAt: previous?.createdAt ?? api.now(),
            },
          });
          const handle = handleOf((await options.brain.read()).handles, "wake", id) ?? "record";
          return textOutput(`Wake ${handle} armed.`);
        },
      }),
      defineTool({
        name: "collapse",
        description:
          "End the live context and rebuild it from the Brain. Rare, and never for ordinary work: call this only when the map and the books have diverged past what the context can work with. The person may collapse at any time; so may you. No approval is involved on either path.",
        parameters: obj({ reason: str({ minLength: 1, maxLength: 1000 }) }),
        replay: "safe",
        execute: async (args) => {
          options.onCollapseRequest?.();
          return textOutput(
            `Collapse noted: ${args.reason.trim()}. Finish this run; the context rebuilds from the Brain when it ends. Chat anything the person must see before then.`,
          );
        },
      }),
      defineTool({
        name: "sleep",
        description: "End the run. There is nothing left to do until the person or a wake says otherwise.",
        parameters: obj({}),
        replay: "safe",
        execute: async () => {
          // §13a: only a deliberate sleep stops the agent. The control flag
          // ends the run without another model request; without it the
          // state-block continuation would let the run continue forever.
          return { output: [{ type: "text" as const, text: "Carto is asleep." }], control: { terminate: true } };
        },
      }),
    ],
  });
}

async function verifyFileEvidence(
  projectRoot: string,
  evidence: { path: string; startLine: number; endLine: number; digest: string; excerpt: string },
): Promise<SourceRef> {
  const inspected = await inspectProjectFile(projectRoot, evidence);
  if (inspected.digest !== evidence.digest) {
    throw new Error(`Evidence changed before Carto could save ${inspected.path}.`);
  }
  return {
    kind: "file",
    path: inspected.path,
    startLine: inspected.startLine,
    endLine: inspected.endLine,
    digest: inspected.digest,
    excerpt: inspected.excerpt,
    freshness: "fresh",
  };
}

function findLedger(brain: Awaited<ReturnType<BrainStore["read"]>>, handle: string) {
  const resolved = resolveHandleOfKind(brain.handles, handle, ["ledger"]);
  const entry = brain.ledger.find((candidate) => candidate.id === resolved.id);
  if (entry === undefined) throw new Error(`The handle ${handle.toUpperCase()} does not name a Ledger record.`);
  return entry;
}

function findAtlas(brain: Awaited<ReturnType<BrainStore["read"]>>, handle: string) {
  const resolved = resolveHandleOfKind(brain.handles, handle, ["atlas"]);
  const node = brain.atlas.find((candidate) => candidate.id === resolved.id);
  if (node === undefined) throw new Error(`The handle ${handle.toUpperCase()} does not name an Atlas record.`);
  return node;
}

function renderWakes(brain: Awaited<ReturnType<BrainStore["read"]>>, wakes: readonly WakeEntry[]): string {
  if (wakes.length === 0) return "No wakes are stored.";
  return wakes
    .map((wake) => {
      const handle = handleOf(brain.handles, "wake", wake.id) ?? "sleeping wake";
      return `${handle}: ${wake.kind}; ${wake.status}; ${wake.condition}; ${wake.reason}`;
    })
    .join("\n");
}

function textOutput(text: string) {
  return { output: [{ type: "text" as const, text }] };
}

type StateBlockOptions = CartoExtensionOptions & { stateBlock: NonNullable<CartoExtensionOptions["stateBlock"]> };

/**
 * The hooks that carry the state block (§20): `beforeRequest` strips the
 * markers the transcript legitimately holds and appends the fresh block as
 * the trailing user-role message; `onYield` continues a tool-free answer with
 * a byte-sized marker. The model always sees exactly one current block.
 */
function stateBlockHooks(options: StateBlockOptions) {
  return {
    beforeRequest: async (request: { readonly messages: readonly import("@earendil-works/pi-ai").Message[] }) => {
      const brain = await options.brain.read();
      const snapshot = options.promptStore?.current();
      const previousPayload = snapshot?.payload as
        | { system?: unknown; messages?: readonly unknown[]; tools?: readonly unknown[] }
        | undefined;
      // The messages Pi is about to send already carry the system message
      // (sections and tools included), so the current estimate needs no
      // guesswork. The previous payload is only used for the delta since the
      // provider's own count; it still includes the block the last request
      // carried while this estimate excludes it, a jitter of ~100 tokens.
      const visible = stripStateBlocks(request.messages);
      const { transcriptTokens, toolWorkTokens, systemTokens } = splitContextMessages(visible);
      const previousSystemTokens =
        previousPayload === undefined ? 0 : estimateSystem(previousPayload);
      const systemFromFirstMessage =
        previousPayload !== undefined &&
        previousPayload.system === undefined &&
        Array.isArray(previousPayload.messages) &&
        previousPayload.messages.length > 0 &&
        ["system", "developer"].includes(String((previousPayload.messages[0] as { role?: unknown }).role));
      const previousBodyTokens =
        previousPayload?.messages === undefined
          ? 0
          : previousPayload.messages.reduce(
              (sum: number, message: unknown, index: number) =>
                systemFromFirstMessage && index === 0 ? sum : sum + estimateSerialized(message),
              0,
            );
      const previousPromptTokens =
        previousPayload === undefined ? undefined : previousSystemTokens + previousBodyTokens;

      // The frozen parts are a static file for this generation; read them once.
      const parts = await cachedProjectionParts(options);

      // Stale named by handle, as of the last evidence refresh.
      const omissions = projectContext(brain, { budget: options.contextBudget }).omissions;
      const stale = [...new Set(omissions.filter((omission) => omission.reason === "stale").map((omission) => omission.label))];

      // Armed and ready wakes, named by handle.
      const wakes = brain.wakes
        .filter((wake) => wake.status === "armed" || wake.status === "ready")
        .map((wake) => ({
          handle: handleOf(brain.handles, "wake", wake.id) ?? "?",
          kind: wake.kind,
          condition: wake.condition,
          status: wake.status as "armed" | "ready",
        }));

      const marks = atlasPathMarks(brain);
      const tree = await renderProjectTree(options.projectRoot, { depth: 2, marks, maxLines: 60 });

      const block = renderStateBlock({
        transcriptTokens,
        toolWorkTokens,
        systemTokens,
        previousPromptTokens,
        lastReportedInput: snapshot?.usage?.input,
        contextWindow: options.contextWindow ?? 32_768,
        parts,
        pending: options.stateBlock.pendingWrites(),
        stale,
        wakes,
        tree: { root: options.projectRoot, depth: 2, lines: tree.lines },
      });
      return { messages: appendStateBlock(visible, block) };
    },
    onYield: () => ({ continue: STATE_BLOCK_MARKER }),
  };
}

/**
 * Split the request's messages into the three estimates the block reports.
 * The system message is rendered as the flattened prompt the model reads:
 * its content, its sections, and its tools. After it, an assistant message
 * carrying a tool call counts as tool work, as does every tool-result
 * message; everything else is transcript. Whole-message attribution keeps
 * the estimates additive.
 */
function splitContextMessages(messages: readonly import("@earendil-works/pi-ai").Message[]): {
  transcriptTokens: number;
  toolWorkTokens: number;
  systemTokens: number;
} {
  let transcriptTokens = 0;
  let toolWorkTokens = 0;
  let systemTokens = 0;
  for (const message of messages) {
    const role = String((message as { role?: unknown }).role);
    if (role === "system") {
      systemTokens += estimateSystemMessage(message);
      continue;
    }
    const toolWork =
      role === "toolResult" ||
      role === "tool" ||
      (role === "assistant" &&
        Array.isArray((message as { content?: unknown }).content) &&
        (message as { content: readonly unknown[] }).content.some(
          (block) => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "toolCall",
        ));
    if (toolWork) toolWorkTokens += estimateSerialized(message);
    else transcriptTokens += estimateSerialized(message);
  }
  return { transcriptTokens, toolWorkTokens, systemTokens };
}

function estimateSystemMessage(message: unknown): number {
  const m = message as {
    content?: unknown;
    sections?: Record<string, string | null>;
    toolsAdded?: readonly unknown[];
  };
  const parts: string[] = [];
  const content = typeof m.content === "string" ? m.content : contentText(m.content);
  if (content.length > 0) parts.push(content);
  for (const value of Object.values(m.sections ?? {})) {
    if (value !== null && value.length > 0) parts.push(value);
  }
  if (m.toolsAdded !== undefined && m.toolsAdded.length > 0) parts.push(safeJson(m.toolsAdded) ?? "");
  const text = parts.join("\n\n");
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4));
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part !== null && typeof part === "object" && "text" in part) {
        const value = (part as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      }
      return "";
    })
    .join("\n");
}

/** The provider payload's system prompt, as text, for both Anthropic (`system`) and OpenAI (leading system message). */
function estimateSystem(payload: { system?: unknown; messages?: readonly unknown[] }): number {
  if (typeof payload.system === "string") return estimateSerialized(payload.system);
  if (Array.isArray(payload.system)) return estimateSerialized(payload.system);
  const first = payload.messages?.[0] as { role?: unknown; content?: unknown } | undefined;
  if (first !== undefined && (first.role === "system" || first.role === "developer")) {
    return estimateSerialized(first);
  }
  return 0;
}

function estimateSerialized(value: unknown): number {
  const text = safeJson(value) ?? "";
  return Math.max(1, Math.ceil(text.length / 4));
}

const partsCache = new WeakMap<object, { ledger: number; atlas: number; chat: number; pins: number; wakes: number }>();

/** Read the frozen per-part sums once per extension instance; atomically written at creation. */
async function cachedProjectionParts(options: CartoExtensionOptions & { stateBlock: NonNullable<CartoExtensionOptions["stateBlock"]> }) {
  const cached = partsCache.get(options);
  if (cached !== undefined) return cached;
  let parts = { ledger: 0, atlas: 0, chat: 0, pins: 0, wakes: 0 };
  try {
    const parsed = JSON.parse(await readFile(options.stateBlock.partsPath, "utf8")) as { parts?: typeof parts };
    if (parsed.parts !== undefined) parts = { ...parts, ...parsed.parts };
  } catch {
    // A missing or unreadable parts file means every number reads ▤0; never fail the request.
  }
  partsCache.set(options, parts);
  return parts;
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
