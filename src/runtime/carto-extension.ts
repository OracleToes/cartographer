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
import type { AtlasEdge, AtlasEdgeKind, SourceRef, WakeEntry } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { pathFingerprint } from "./path-wake-task.js";
import { parseTimeWakeCondition } from "./wake.js";
import { digestProjectFile, inspectProjectFile, resolveProjectWatchPath } from "./workspace.js";

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
   * Where the screen reads the prompt the model was sent.
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
}

export function createCartoExtension(options: CartoExtensionOptions) {
  return defineExtension({
    name: "carto",
    sections: [
      section(
        "carto-context",
        async () => {
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
       * definition has been applied. Recording them here is what makes the
       * Context tab true: the screen reads this, and it has no other way to
       * obtain a prompt that was not sent.
       */
      hook(GenerationTask, {
        beforeProviderRequest: (request) => {
          // The payload is the provider's own body. It is recorded as-is; the
          // tree renderer reads it, and a field it does not know still reaches
          // the real view because the real view is this JSON.
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
          return textOutput("Carto is asleep.");
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
