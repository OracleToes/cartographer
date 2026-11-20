import { removeById, replaceById } from "./brain.js";
import { ensureHandles, freshHandles } from "./handles.js";
import type {
  AtlasNode,
  CarryPin,
  ChatRecord,
  DeletionTarget,
  LedgerEntry,
  CartoBrain,
  UserPin,
  WakeEntry,
} from "./types.js";

export type EffectRequest =
  | { kind: "arm-wake"; wakeId: string }
  | { kind: "cancel-wake"; wakeId: string };

export type CartoCommand =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "pin.user.add"; pin: UserPin }
  | { kind: "pin.carry.add"; pin: CarryPin }
  | { kind: "wake.upsert"; wake: WakeEntry }
  | { kind: "record.delete"; target: DeletionTarget }
  | { kind: "legacy.import"; ledger: LedgerEntry[]; atlas: AtlasNode[] }
  /** A collapse: rebuild the generation-local handle table from 1. The Brain keeps its records. */
  | { kind: "collapse.rotate" }
  /** Refresh the private handle table without a content change. */
  | { kind: "handles.sync" };

export interface Decision {
  brain: CartoBrain;
  effects: EffectRequest[];
}

export class DomainError extends Error {}

/**
 * Apply one command. The handle table is refreshed after every decision, so a
 * new record receives its short public handle at once and an edited record
 * keeps the handle it already had. The table is private Brain state.
 */
export function decide(brain: CartoBrain, command: CartoCommand): Decision {
  const decision = applyCommand(brain, command);
  return {
    ...decision,
    brain: { ...decision.brain, handles: ensureHandles(decision.brain.handles, decision.brain) },
  };
}

function applyCommand(brain: CartoBrain, command: CartoCommand): Decision {
  switch (command.kind) {
    case "chat.record":
      return { brain: { ...brain, chat: replaceById(brain.chat, command.record) }, effects: [] };
    case "ledger.upsert":
      return { brain: { ...brain, ledger: replaceById(brain.ledger, command.entry) }, effects: [] };
    case "atlas.upsert":
      return { brain: { ...brain, atlas: replaceById(brain.atlas, command.node) }, effects: [] };
    case "pin.user.add":
      return { brain: { ...brain, userPins: replaceById(brain.userPins, command.pin) }, effects: [] };
    case "pin.carry.add":
      return { brain: { ...brain, carryPins: replaceById(brain.carryPins, command.pin) }, effects: [] };
    case "wake.upsert":
      return {
        brain: { ...brain, wakes: replaceById(brain.wakes, command.wake) },
        effects: wakeEffect(command.wake),
      };
    case "record.delete":
      return deleteNow(brain, command.target);
    case "collapse.rotate":
      return { brain: { ...brain, handles: freshHandles(brain) }, effects: [] };
    case "legacy.import":
      return {
        brain: {
          ...brain,
          ledger: mergeImportedRecords(brain.ledger, command.ledger),
          atlas: mergeImportedRecords(brain.atlas, command.atlas),
        },
        effects: [],
      };
    case "handles.sync":
      return { brain, effects: [] };
    default:
      return assertNever(command);
  }
}

function mergeImportedRecords<T extends { id: string; createdAt: number }>(existing: T[], imported: T[]): T[] {
  let merged = existing;
  for (const entry of imported) {
    const previous = merged.find((candidate) => candidate.id === entry.id);
    merged = replaceById(merged, previous === undefined ? entry : { ...entry, createdAt: previous.createdAt });
  }
  return merged;
}

/** Deletion is a single step. There is no pending state and no undo. */
function deleteNow(brain: CartoBrain, target: DeletionTarget): Decision {
  switch (target.target) {
    case "chat":
      return { brain: { ...brain, chat: removeById(brain.chat, target.id) }, effects: [] };
    case "ledger":
      return { brain: { ...brain, ledger: removeById(brain.ledger, target.id) }, effects: [] };
    case "atlas":
      return { brain: { ...brain, atlas: removeById(brain.atlas, target.id) }, effects: [] };
    case "user-pin":
      return { brain: { ...brain, userPins: removeById(brain.userPins, target.id) }, effects: [] };
    case "carry-pin":
      return { brain: { ...brain, carryPins: removeById(brain.carryPins, target.id) }, effects: [] };
    default:
      return assertNever(target);
  }
}

function wakeEffect(wake: WakeEntry): EffectRequest[] {
  if (wake.status === "armed") return [{ kind: "arm-wake", wakeId: wake.id }];
  if (wake.status === "cancelled") return [{ kind: "cancel-wake", wakeId: wake.id }];
  return [];
}

function assertNever(value: never): never {
  throw new DomainError(`Unknown command: ${JSON.stringify(value)}`);
}
