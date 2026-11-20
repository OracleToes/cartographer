/**
 * Brain writes as pure transformations over an explicit value (MINI.md §12).
 *
 * `applyWrite(brain, write, now)` returns the next Brain, or throws a
 * `BrainError` with a person-readable message. Unknown handles and unknown
 * IDs are explicit errors; a partially applied write never escapes — the
 * store applies it inside one transaction or not at all.
 *
 * Deletion is a single step with no pending state and no undo
 * (MINI.md §2.1, confirmed).
 */
import { reconcileHandles } from "./handles.js";
import type {
  CartoBrain,
  CarryPin,
  LedgerEntry,
  RecordId,
  UserPin,
  WakeEntry,
  WakeStatus,
  AtlasNode,
  ChatRecord,
} from "./records.js";

export class BrainError extends Error {}

export type BrainWrite =
  | { kind: "chat.record"; record: ChatRecord }
  | { kind: "evidence.refresh"; marks: Array<{ record: "atlas" | "user-pin" | "carry-pin"; id: RecordId; index: number | null; freshness: "fresh" | "stale" }> }
  | { kind: "chat.update"; id: RecordId; text: string; updatedAt: number }
  | { kind: "ledger.upsert"; entry: LedgerEntry }
  | { kind: "atlas.upsert"; node: AtlasNode }
  | { kind: "pin.add"; layer: "user" | "carry"; pin: UserPin | CarryPin }
  | { kind: "pin.remove"; id: RecordId }
  | { kind: "wake.arm"; wake: WakeEntry }
  | { kind: "wake.setStatus"; id: RecordId; status: WakeStatus }
  | { kind: "delete"; target: "chat" | "ledger" | "atlas" | "user-pin" | "carry-pin"; id: RecordId };

export function applyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  const next = doApplyWrite(brain, write, now);
  return reconcileHandles(next);
}

function doApplyWrite(brain: CartoBrain, write: BrainWrite, now: number): CartoBrain {
  switch (write.kind) {
    case "evidence.refresh": {
      // Written only at a rebuild (MINI.md §28: digest drift is marked stale
      // at rebuild). Blocks nothing, deletes nothing, and never renumbers
      // handles.
      let next = brain;
      for (const mark of write.marks) {
        if (mark.record === "atlas") {
          const node = next.atlas.find((candidate) => candidate.id === mark.id);
          if (node === undefined) throw new BrainError("An evidence mark names an Atlas node that does not exist.");
          if (mark.index === null || node.evidence[mark.index] === undefined) {
            throw new BrainError("An evidence mark names evidence that does not exist.");
          }
          const evidence = node.evidence.map((ref, index) =>
            index === mark.index ? { ...ref, freshness: mark.freshness } : ref,
          );
          next = {
            ...next,
            atlas: next.atlas.map((candidate) => (candidate.id === mark.id ? { ...candidate, evidence } : candidate)),
          };
          continue;
        }
        if (mark.index !== null) throw new BrainError("A pin's evidence is its single source; index must be null.");
        const target = mark.record === "user-pin" ? next.userPins : next.carryPins;
        const pin = target.find((candidate) => candidate.id === mark.id);
        if (pin === undefined) throw new BrainError("An evidence mark names a pin that does not exist.");
        const refreshed = { ...pin, source: { ...pin.source, freshness: mark.freshness } };
        if (mark.record === "user-pin") {
          next = { ...next, userPins: next.userPins.map((candidate) => (candidate.id === mark.id ? refreshed : candidate)) };
        } else {
          next = { ...next, carryPins: next.carryPins.map((candidate) => (candidate.id === mark.id ? refreshed : candidate)) };
        }
      }
      return next;
    }

    case "chat.record":
      return { ...brain, chat: [...brain.chat, write.record] };

    case "chat.update": {
      const record = brain.chat.find((candidate) => candidate.id === write.id);
      if (record === undefined) throw new BrainError("No Chat record is named by that handle.");
      const chat = brain.chat.map((candidate) =>
        candidate.id === write.id ? { ...candidate, text: write.text, updatedAt: write.updatedAt } : candidate,
      );
      return { ...brain, chat };
    }

    case "ledger.upsert": {
      const exists = brain.ledger.some((entry) => entry.id === write.entry.id);
      const ledger = exists
        ? brain.ledger.map((entry) => (entry.id === write.entry.id ? write.entry : entry))
        : [...brain.ledger, write.entry];
      return { ...brain, ledger };
    }

    case "atlas.upsert": {
      // Edges are stored as written (MINI.md §2.1, confirmed): the graph is
      // the agent's garden and permissive by intent — a flood of unconnected
      // nodes or an edge to a vanished target is the agent's to tend, not
      // the runtime's to validate away.
      const exists = brain.atlas.some((node) => node.id === write.node.id);
      const atlas = exists
        ? brain.atlas.map((node) => (node.id === write.node.id ? write.node : node))
        : [...brain.atlas, write.node];
      return { ...brain, atlas };
    }

    case "pin.add": {
      // A pin means "keep it here" (MINI.md §4.1). No uniqueness is demanded;
      // the graph is the agent's garden and permissive by intent (§2.3).
      if (write.layer === "user") {
        const pin = write.pin as UserPin;
        return { ...brain, userPins: [...brain.userPins, pin] };
      }
      const pin = write.pin as CarryPin;
      return { ...brain, carryPins: [...brain.carryPins, pin] };
    }

    case "pin.remove": {
      const fromUser = brain.userPins.filter((pin) => pin.id !== write.id);
      const fromCarry = brain.carryPins.filter((pin) => pin.id !== write.id);
      if (fromUser.length === brain.userPins.length && fromCarry.length === brain.carryPins.length) {
        throw new BrainError("No pin is named by that handle.");
      }
      return { ...brain, userPins: fromUser, carryPins: fromCarry };
    }

    case "wake.arm":
      return { ...brain, wakes: [...brain.wakes, write.wake] };

    case "wake.setStatus": {
      const wake = brain.wakes.find((candidate) => candidate.id === write.id);
      if (wake === undefined) throw new BrainError("No wake is named by that handle.");
      const wakes = brain.wakes.map((candidate) =>
        candidate.id === write.id ? { ...candidate, status: write.status } : candidate,
      );
      return { ...brain, wakes };
    }

    case "delete": {
      switch (write.target) {
        case "chat": {
          const chat = brain.chat.filter((record) => record.id !== write.id);
          if (chat.length === brain.chat.length) throw new BrainError("No Chat record is named by that handle.");
          return { ...brain, chat };
        }
        case "ledger": {
          const ledger = brain.ledger.filter((entry) => entry.id !== write.id);
          if (ledger.length === brain.ledger.length) throw new BrainError("No Ledger record is named by that handle.");
          // Evidence IDs pointing at the deleted entry are the agent's to clean up;
          // the Brain does not cascade a delete across the graph.
          return { ...brain, ledger };
        }
        case "atlas": {
          const atlas = brain.atlas.filter((node) => node.id !== write.id);
          if (atlas.length === brain.atlas.length) throw new BrainError("No Atlas node is named by that handle.");
          // No cascade: edges naming the deleted node stay as they are. The
          // agent tends its own graph (§2.1, §2.3); a dead reference is
          // something it can see and repair, not something to hide.
          return { ...brain, atlas };
        }
        case "user-pin": {
          const userPins = brain.userPins.filter((pin) => pin.id !== write.id);
          if (userPins.length === brain.userPins.length) throw new BrainError("No pin is named by that handle.");
          return { ...brain, userPins };
        }
        case "carry-pin": {
          const carryPins = brain.carryPins.filter((pin) => pin.id !== write.id);
          if (carryPins.length === brain.carryPins.length) throw new BrainError("No pin is named by that handle.");
          return { ...brain, carryPins };
        }
      }
    }
  }
}
