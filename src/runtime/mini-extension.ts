import { arr, int, lit, obj, oneOf, opt, str, union } from "@earendil-works/pi-schema";
import { CompactionTask, defineExtension, defineTool, hook, section } from "@earendil-works/pi-durable";
import type { AnyTask } from "@earendil-works/pi-durable";

import { mergeCarryPins, projectContext, renderContextPlan } from "../domain/context.js";
import type { SourceRef, WakeEntry } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { LiveCarryDocument, readLiveCarry } from "./live-carry.js";
import { parseUnifiedPatch } from "./patch.js";
import { pathFingerprint } from "./path-wake-task.js";
import { parseTimeWakeCondition } from "./wake.js";
import { digestProjectFile, inspectProjectFile, resolveProjectWatchPath } from "./workspace.js";

const RecordId = str({ minLength: 1, maxLength: 160 });
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
  obj({ action: lit("remove"), id: RecordId }),
]);
const WakeRequest = union([
  obj({
    action: lit("arm"),
    id: RecordId,
    kind: WakeKind,
    condition: str({ minLength: 1, maxLength: 4096 }),
    reason: str({ minLength: 1, maxLength: 1000 }),
  }),
  obj({ action: lit("cancel"), id: RecordId, reason: str({ minLength: 1, maxLength: 1000 }) }),
  obj({ action: lit("view"), id: opt(RecordId) }),
]);

export interface MiniExtensionOptions {
  brain: BrainStore;
  projectRoot: string;
  /** The generation file that owns this live context. */
  contextId: string;
  contextBudget: number;
  durableTasks?: readonly AnyTask[];
}

export function createMiniExtension(options: MiniExtensionOptions) {
  return defineExtension({
    name: "cartographer-mini",
    sections: [
      section(
        "mini-context",
        async (input, context) => {
          const brain = await options.brain.read();
          const stored = await input.read.snapshot(LiveCarryDocument, input.conversationId, context);
          return renderContextPlan(
            projectContext(brain, {
              budget: options.contextBudget,
              carryPins: mergeCarryPins(readLiveCarry(stored), brain.carryPins),
            }),
          );
        },
        { tag: false },
      ),
    ],
    ...(options.durableTasks === undefined ? {} : { tasks: options.durableTasks }),
    hooks: [
      hook(CompactionTask, {
        beforeCompact: async () => {
          await options.brain.apply({
            kind: "collapse.request",
            detail: "The live context needs a collapse before more model work.",
          });
          return { decline: true };
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
            record: { id: `agent:${api.callId}`, author: "agent", text: args.text, createdAt: api.now() },
          });
          return textOutput("Chat message saved.");
        },
      }),
      defineTool({
        name: "ledger",
        description: "Create or update one durable goal, note, or question.",
        parameters: obj({
          id: RecordId,
          kind: LedgerKind,
          text: Text,
          status: Status,
          answer: OptionalText,
          evidenceIds: opt(arr(RecordId, { maxItems: 32 })),
        }),
        replay: "safe",
        execute: async (args, api) => {
          const previous = (await options.brain.read()).ledger.find((entry) => entry.id === args.id);
          await options.brain.apply({
            kind: "ledger.upsert",
            entry: {
              id: args.id,
              kind: args.kind,
              text: args.text,
              status: args.status,
              answer: args.answer === undefined ? null : { text: args.answer, evidenceIds: args.evidenceIds ?? [] },
              createdAt: previous?.createdAt ?? api.now(),
              updatedAt: api.now(),
            },
          });
          return textOutput(`Ledger ${args.id} saved.`);
        },
      }),
      defineTool({
        name: "atlas",
        description: "Create or update one short, source-backed Atlas claim.",
        parameters: obj({
          id: RecordId,
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
          links: opt(arr(RecordId, { maxItems: 32 })),
        }),
        replay: "safe",
        execute: async (args, api) => {
          const evidence = await Promise.all(args.evidence.map((item) => verifyFileEvidence(options.projectRoot, item)));
          const previous = (await options.brain.read()).atlas.find((entry) => entry.id === args.id);
          await options.brain.apply({
            kind: "atlas.upsert",
            node: {
              id: args.id,
              title: args.title,
              claim: args.claim,
              evidence,
              links: args.links ?? [],
              createdAt: previous?.createdAt ?? api.now(),
              updatedAt: api.now(),
            },
          });
          return textOutput(`Atlas ${args.id} saved.`);
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
          "Add or remove one agent carry pin. A file source needs exact inspected evidence. A context source keeps a selected current-context item for one collapse period.",
        parameters: PinRequest,
        replay: "safe",
        execute: async (args, api) => {
          if (args.action === "remove") {
            await options.brain.apply({ kind: "pin.carry.remove", id: args.id });
            return textOutput(`Carry pin ${args.id} removed.`);
          }
          const source: SourceRef =
            args.source.kind === "file"
              ? await verifyFileEvidence(options.projectRoot, args.source)
              : { kind: "context", contextId: options.contextId, excerpt: args.source.excerpt, freshness: "fresh" };
          await options.brain.apply({
            kind: "pin.carry.add",
            pin: { id: `carry:${api.callId}`, item: args.item, reason: args.reason, source, createdAt: api.now() },
          });
          return textOutput("Carry pin saved.");
        },
      }),
      defineTool({
        name: "propose_change",
        description: "Store a patch for person review. This tool cannot apply the patch.",
        parameters: obj({
          rationale: Text,
          patch: Text,
          base: arr(obj({ path: str({ minLength: 1, maxLength: 4096 }), digest: str({ minLength: 1, maxLength: 128 }) }), {
            maxItems: 128,
          }),
        }),
        replay: "safe",
        execute: async (args, api) => {
          parseUnifiedPatch(args.patch);
          const base = await Promise.all(
            args.base.map(async (entry) => {
              const current = await digestProjectFile(options.projectRoot, entry.path);
              if (current.digest !== entry.digest) throw new Error(`The proposed base changed for ${entry.path}.`);
              return current;
            }),
          );
          await options.brain.apply({
            kind: "change.upsert",
            change: {
              id: `change:${api.callId}`,
              rationale: args.rationale,
              patch: args.patch,
              base,
              status: "proposed",
              createdAt: api.now(),
              resolvedAt: null,
            },
          });
          return textOutput("Change proposal saved for review.");
        },
      }),
      defineTool({
        name: "wake",
        description: "Arm, cancel, or view durable time and path wakes. A time condition is ISO 8601 or Unix milliseconds.",
        parameters: WakeRequest,
        replay: "safe",
        execute: async (args, api) => {
          const brain = await options.brain.read();
          if (args.action === "view") {
            const wakes = args.id === undefined ? brain.wakes : brain.wakes.filter((wake) => wake.id === args.id);
            return textOutput(renderWakes(wakes));
          }

          const previous = brain.wakes.find((wake) => wake.id === args.id);
          if (args.action === "cancel") {
            if (previous === undefined) return textOutput(`Wake ${args.id} is not active.`);
            await options.brain.apply({
              kind: "wake.upsert",
              wake: { ...previous, status: "cancelled", reason: args.reason },
            });
            return textOutput(`Wake ${args.id} cancelled.`);
          }

          if (args.kind === "time") parseTimeWakeCondition(args.condition);
          else {
            await resolveProjectWatchPath(options.projectRoot, args.condition);
            await pathFingerprint(options.projectRoot, args.condition);
          }
          await options.brain.apply({
            kind: "wake.upsert",
            wake: {
              id: args.id,
              kind: args.kind,
              condition: args.condition,
              status: "armed",
              reason: args.reason,
              createdAt: previous?.createdAt ?? api.now(),
            },
          });
          return textOutput(`Wake ${args.id} armed.`);
        },
      }),
      defineTool({
        name: "request_collapse",
        description: "Request a Mini context collapse when the current live context is no longer useful. Do not call this for ordinary work.",
        parameters: obj({ reason: str({ minLength: 1, maxLength: 1000 }) }),
        replay: "safe",
        execute: async (args) => {
          await options.brain.apply({ kind: "collapse.request", detail: args.reason });
          return textOutput("Collapse request saved.");
        },
      }),
      defineTool({
        name: "sleep",
        description: "Store a short handoff and enter the sleeping state.",
        parameters: obj({
          intent: Text,
          activeLedgerIds: arr(RecordId, { maxItems: 32 }),
          openQuestionIds: arr(RecordId, { maxItems: 32 }),
          relevantAtlasIds: arr(RecordId, { maxItems: 32 }),
          nextAction: Text,
          note: opt(str({ maxLength: 4000 })),
        }),
        replay: "safe",
        execute: async (args, api) => {
          await options.brain.apply({
            kind: "handoff.set",
            handoff: {
              intent: args.intent,
              activeLedgerIds: args.activeLedgerIds,
              openQuestionIds: args.openQuestionIds,
              relevantAtlasIds: args.relevantAtlasIds,
              nextAction: args.nextAction,
              note: args.note ?? "",
              updatedAt: api.now(),
            },
          });
          await options.brain.apply({ kind: "activity.set", activity: { kind: "sleeping", detail: null } });
          return textOutput("Mini is sleeping.");
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
    throw new Error(`Evidence changed before Mini could save ${inspected.path}.`);
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

function renderWakes(wakes: readonly WakeEntry[]): string {
  if (wakes.length === 0) return "No wakes are stored.";
  return wakes.map((wake) => `${wake.id}: ${wake.kind}; ${wake.status}; ${wake.condition}; ${wake.reason}`).join("\n");
}

function textOutput(text: string) {
  return { output: [{ type: "text" as const, text }] };
}
