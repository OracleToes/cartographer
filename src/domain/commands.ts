import {
  addDeletionMark,
  purgeMarkedRecords,
  removeById,
  removeDeletionMark,
  replaceById,
} from "./brain.js";
import { ensureHandles } from "./handles.js";
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
  CartoBrain,
  UserPin,
  WakeEntry,
} from "./types.js";

export type EffectRequest =
  | { kind: "remove-archive"; generation: GenerationId }
  /** Immediate removal discards an old context instead of retaining an archive. */
  | { kind: "discard-context"; generation: GenerationId }
  | { kind: "apply-change"; changeId: string }
  | { kind: "arm-wake"; wakeId: string }
  | { kind: "cancel-wake"; wakeId: string };

export type CartoCommand =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "pin.user.add"; pin: UserPin }
  | { kind: "pin.user.remove"; id: string; markedAt: number }
  | { kind: "pin.carry.add"; pin: CarryPin }
  | { kind: "pin.carry.remove"; id: string; markedAt: number }
  | { kind: "handoff.set"; handoff: Handoff | null }
  | { kind: "wake.upsert"; wake: WakeEntry }
  | { kind: "change.upsert"; change: ChangeProposal }
  | { kind: "legacy.import"; ledger: LedgerEntry[]; atlas: AtlasNode[] }
  | { kind: "deletion.mark"; mark: DeletionMark }
  | { kind: "deletion.unmark"; target: DeletionTarget }
  | { kind: "deletion.now"; target: DeletionTarget }
  | { kind: "activity.set"; activity: Activity }
  | { kind: "context.initialize"; liveGeneration: GenerationId }
  | { kind: "collapse.request"; detail: string }
  | { kind: "collapse.rotate"; newLiveGeneration: GenerationId }
  | { kind: "context.restart"; newLiveGeneration: GenerationId }
  /** Refresh the private handle table without a content change. */
  | { kind: "handles.sync"; carryPins?: CarryPin[] };

export interface Decision {
  brain: CartoBrain;
  effects: EffectRequest[];
  /**
   * A collapse or immediate restart starts a new live generation and rebuilds
   * every short handle, so `decide` must not carry the old table forward.
   */
  resetHandles?: boolean;
}

export class DomainError extends Error {}

/**
 * Apply one command. The handle table is refreshed after every decision, so a
 * new record receives its short public handle at once and an edited record
 * keeps the handle it already had. The table is private Brain state.
 */
export function decide(brain: CartoBrain, command: CartoCommand): Decision {
  const decision = applyCommand(brain, command);
  const carryPins = command.kind === "handles.sync" ? command.carryPins : undefined;
  const previous = decision.resetHandles === true ? undefined : brain.handles;
  return {
    ...decision,
    brain: { ...decision.brain, handles: ensureHandles(previous, decision.brain, carryPins) },
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
    case "pin.user.remove":
      return { brain: addDeletionMark(brain, { target: "user-pin", id: command.id, markedAt: command.markedAt }), effects: [] };
    case "pin.carry.add": 
      return { brain: { ...brain, carryPins: replaceById(brain.carryPins, command.pin) }, effects: [] };
    case "pin.carry.remove":
      return { brain: addDeletionMark(brain, { target: "carry-pin", id: command.id, markedAt: command.markedAt }), effects: [] };
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
    case "deletion.now":
      return removeNow(brain, command.target);
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
    case "context.restart":
      return restartGeneration(brain, command.newLiveGeneration);
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

function removeNow(brain: CartoBrain, target: DeletionTarget): Decision {
  switch (target.target) {
    case "chat":
      return { brain: { ...brain, chat: removeById(brain.chat, target.id), deletionMarks: removeDeletionMark(brain, target).deletionMarks }, effects: [] };
    case "ledger":
      return { brain: { ...brain, ledger: removeById(brain.ledger, target.id), deletionMarks: removeDeletionMark(brain, target).deletionMarks }, effects: [] };
    case "atlas":
      return { brain: { ...brain, atlas: removeById(brain.atlas, target.id), deletionMarks: removeDeletionMark(brain, target).deletionMarks }, effects: [] };
    case "user-pin":
      return { brain: { ...brain, userPins: removeById(brain.userPins, target.id), deletionMarks: removeDeletionMark(brain, target).deletionMarks }, effects: [] };
    case "carry-pin":
      return { brain: { ...brain, carryPins: removeById(brain.carryPins, target.id), deletionMarks: removeDeletionMark(brain, target).deletionMarks }, effects: [] };
    default:
      return assertNever(target);
  }
}

/**
 * A non-collapse generation restart used after Delete now or Remove now.
 *
 * Carto does not keep the old live session as an archive here. It can contain
 * the removed material. The new generation is prefilled from the new Brain
 * projection only, and every old context generation is scheduled for cleanup.
 */
function restartGeneration(brain: CartoBrain, newLiveGeneration: GenerationId): Decision {
  if (brain.context.liveGeneration === null) throw new DomainError("A restart needs a live context generation.");
  if (brain.context.liveGeneration === newLiveGeneration) throw new DomainError("A restart needs a new live context generation.");
  const discarded = [brain.context.liveGeneration, brain.context.archiveGeneration].filter(
    (generation): generation is GenerationId => generation !== null,
  );
  return {
    resetHandles: true,
    brain: {
      ...brain,
      context: { liveGeneration: newLiveGeneration, archiveGeneration: null },
      activity: { kind: "idle", detail: null },
    },
    effects: discarded.map((generation) => ({ kind: "discard-context" as const, generation })),
  };
}

function rotateGeneration(brain: CartoBrain, newLiveGeneration: GenerationId): Decision {
  if (brain.context.liveGeneration === null) {
    throw new DomainError("A collapse needs a live context generation.");
  }
  if (brain.context.liveGeneration === newLiveGeneration) {
    throw new DomainError("A collapse needs a new live context generation.");
  }

  const oldArchive = brain.context.archiveGeneration;
  const withoutDeleted = purgeMarkedRecords(brain);
  return {
    resetHandles: true,
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
