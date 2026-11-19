import {
  addDeletionMark,
  purgeMarkedRecords,
  removeById,
  removeDeletionMark,
  replaceById,
} from "./brain.js";
import type {
  Activity,
  AtlasNode,
  CarryPin,
  ChangeProposal,
  ChatRecord,
  DeletionMark,
  DeletionTarget,
  GenerationId,
  Handoff,
  LedgerEntry,
  MiniBrain,
  UserPin,
  WakeEntry,
} from "./types.js";

export type EffectRequest =
  | { kind: "remove-archive"; generation: GenerationId }
  | { kind: "apply-change"; changeId: string }
  | { kind: "arm-wake"; wakeId: string }
  | { kind: "cancel-wake"; wakeId: string };

export type MiniCommand =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "pin.user.add"; pin: UserPin }
  | { kind: "pin.user.remove"; id: string }
  | { kind: "pin.carry.add"; pin: CarryPin }
  | { kind: "pin.carry.remove"; id: string }
  | { kind: "handoff.set"; handoff: Handoff | null }
  | { kind: "wake.upsert"; wake: WakeEntry }
  | { kind: "change.upsert"; change: ChangeProposal }
  | { kind: "legacy.import"; ledger: LedgerEntry[]; atlas: AtlasNode[] }
  | { kind: "deletion.mark"; mark: DeletionMark }
  | { kind: "deletion.unmark"; target: DeletionTarget }
  | { kind: "activity.set"; activity: Activity }
  | { kind: "context.initialize"; liveGeneration: GenerationId }
  | { kind: "collapse.request"; detail: string }
  | { kind: "collapse.rotate"; newLiveGeneration: GenerationId };

export interface Decision {
  brain: MiniBrain;
  effects: EffectRequest[];
}

export class DomainError extends Error {}

export function decide(brain: MiniBrain, command: MiniCommand): Decision {
  switch (command.kind) {
    case "chat.record":
      return { brain: { ...brain, chat: replaceById(brain.chat, command.record) }, effects: [] };
    case "ledger.upsert":
      return { brain: { ...brain, ledger: replaceById(brain.ledger, command.entry) }, effects: [] };
    case "atlas.upsert":
      return { brain: { ...brain, atlas: replaceById(brain.atlas, command.node) }, effects: [] };
    case "pin.user.add":
      return { brain: { ...brain, userPins: replaceById(brain.userPins, command.pin) }, effects: [] };
    case "pin.user.remove":
      return { brain: { ...brain, userPins: removeById(brain.userPins, command.id) }, effects: [] };
    case "pin.carry.add":
      return { brain: { ...brain, carryPins: replaceById(brain.carryPins, command.pin) }, effects: [] };
    case "pin.carry.remove":
      return { brain: { ...brain, carryPins: removeById(brain.carryPins, command.id) }, effects: [] };
    case "handoff.set":
      return { brain: { ...brain, handoff: command.handoff }, effects: [] };
    case "wake.upsert":
      return {
        brain: { ...brain, wakes: replaceById(brain.wakes, command.wake) },
        effects: wakeEffect(command.wake),
      };
    case "change.upsert":
      return {
        brain: { ...brain, changes: replaceById(brain.changes, command.change) },
        effects: changeEffect(command.change),
      };
    case "legacy.import":
      return {
        brain: {
          ...brain,
          ledger: mergeImportedRecords(brain.ledger, command.ledger),
          atlas: mergeImportedRecords(brain.atlas, command.atlas),
        },
        effects: [],
      };
    case "deletion.mark":
      return { brain: addDeletionMark(brain, command.mark), effects: [] };
    case "deletion.unmark":
      return { brain: removeDeletionMark(brain, command.target), effects: [] };
    case "activity.set":
      return { brain: { ...brain, activity: command.activity }, effects: [] };
    case "context.initialize":
      if (brain.context.liveGeneration !== null) {
        throw new DomainError("A live context generation already exists.");
      }
      return {
        brain: {
          ...brain,
          context: { liveGeneration: command.liveGeneration, archiveGeneration: null },
        },
        effects: [],
      };
    case "collapse.request":
      return {
        brain: { ...brain, activity: { kind: "waiting-for-collapse", detail: command.detail } },
        effects: [],
      };
    case "collapse.rotate":
      return rotateGeneration(brain, command.newLiveGeneration);
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

function rotateGeneration(brain: MiniBrain, newLiveGeneration: GenerationId): Decision {
  if (brain.context.liveGeneration === null) {
    throw new DomainError("A collapse needs a live context generation.");
  }
  if (brain.context.liveGeneration === newLiveGeneration) {
    throw new DomainError("A collapse needs a new live context generation.");
  }

  const oldArchive = brain.context.archiveGeneration;
  const withoutDeleted = purgeMarkedRecords(brain);
  return {
    brain: {
      ...withoutDeleted,
      carryPins: [],
      context: {
        liveGeneration: newLiveGeneration,
        archiveGeneration: brain.context.liveGeneration,
      },
      activity: { kind: "idle", detail: null },
    },
    effects: oldArchive === null ? [] : [{ kind: "remove-archive", generation: oldArchive }],
  };
}

function wakeEffect(wake: WakeEntry): EffectRequest[] {
  if (wake.status === "armed") return [{ kind: "arm-wake", wakeId: wake.id }];
  if (wake.status === "cancelled") return [{ kind: "cancel-wake", wakeId: wake.id }];
  return [];
}

function changeEffect(change: ChangeProposal): EffectRequest[] {
  return change.status === "approved" ? [{ kind: "apply-change", changeId: change.id }] : [];
}

function assertNever(value: never): never {
  throw new DomainError(`Unknown command: ${JSON.stringify(value)}`);
}
