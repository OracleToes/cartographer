import { arr, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { CompactionTask, defineExtension, defineTool, hook } from "@earendil-works/pi-durable";

import type { SourceRef } from "../domain/types.js";
import { BrainStore } from "./brain-store.js";
import { inspectProjectFile } from "./workspace.js";

const RecordId = str({ minLength: 1, maxLength: 160 });
const Text = str({ minLength: 1, maxLength: 24_000 });
const OptionalText = opt(str({ maxLength: 24_000 }));
const Status = oneOf(["open", "answered", "closed"] as const);
const LedgerKind = oneOf(["goal", "note", "question"] as const);
const WakeKind = oneOf(["time", "path"] as const);
const WakeAction = oneOf(["arm", "cancel"] as const);

export interface MiniExtensionOptions {
  brain: BrainStore;
  projectRoot: string;
}

export function createMiniExtension(options: MiniExtensionOptions) {
  return defineExtension({
    name: "cartographer-mini",
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
          const previous = (await options.brain.read()).atlas.find((entry) => entry.id === args.id);
          await options.brain.apply({
            kind: "atlas.upsert",
            node: {
              id: args.id,
              title: args.title,
              claim: args.claim,
              evidence: args.evidence.map((evidence) => ({ kind: "file", ...evidence, freshness: "fresh" })),
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
        description: "Create one carry pin for the next context generation. Use exact file evidence.",
        parameters: obj({
          item: Text,
          reason: str({ minLength: 1, maxLength: 1000 }),
          path: str({ minLength: 1, maxLength: 4096 }),
          startLine: int({ minimum: 1 }),
          endLine: int({ minimum: 1 }),
          digest: str({ minLength: 1, maxLength: 128 }),
          excerpt: Text,
        }),
        replay: "safe",
        execute: async (args, api) => {
          const source: SourceRef = {
            kind: "file",
            path: args.path,
            startLine: args.startLine,
            endLine: args.endLine,
            digest: args.digest,
            excerpt: args.excerpt,
            freshness: "fresh",
          };
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
            minItems: 1,
            maxItems: 128,
          }),
        }),
        replay: "safe",
        execute: async (args, api) => {
          await options.brain.apply({
            kind: "change.upsert",
            change: {
              id: `change:${api.callId}`,
              rationale: args.rationale,
              patch: args.patch,
              base: args.base,
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
        description: "Arm or cancel one durable time or path wake.",
        parameters: obj({
          action: WakeAction,
          id: RecordId,
          kind: WakeKind,
          condition: str({ minLength: 1, maxLength: 4096 }),
          reason: str({ minLength: 1, maxLength: 1000 }),
        }),
        replay: "safe",
        execute: async (args, api) => {
          await options.brain.apply({
            kind: "wake.upsert",
            wake: {
              id: args.id,
              kind: args.kind,
              condition: args.condition,
              status: args.action === "arm" ? "armed" : "cancelled",
              reason: args.reason,
              createdAt: api.now(),
            },
          });
          return textOutput(args.action === "arm" ? `Wake ${args.id} armed.` : `Wake ${args.id} cancelled.`);
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

function textOutput(text: string) {
  return { output: [{ type: "text" as const, text }] };
}
